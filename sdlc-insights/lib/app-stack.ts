import * as path from 'node:path';
import { Stack, StackProps, Duration, RemovalPolicy, Tags, CfnOutput, Aws } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';

export interface InsightsStackProps extends StackProps {
  domainName: string;
  hostedZoneName: string;
  certificate: acm.ICertificate;
  webAclArn: string;
  modelId: string;
  /** Cognito user pool of the Secure SDLC Advisor: students sign in with the same account. */
  advisorUserPoolId: string;
  advisorUrl: string;
  advisorStackName: string;
  advisorEdgeStackName: string;
  frontendDist?: string;
}

const SERVICES = path.join(__dirname, '..', 'services', 'src');

export class InsightsAppStack extends Stack {
  constructor(scope: Construct, id: string, props: InsightsStackProps) {
    super(scope, id, props);
    Tags.of(this).add('project', 'sdlc-class-insights');
    const prefix = 'sdlc-insights';

    const key = new kms.Key(this, 'DataKey', {
      alias: `alias/${prefix}`, description: 'Class Insights data and logs', enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY, pendingWindow: Duration.days(7),
    });
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs',
      principals: [new iam.ServicePrincipal(`logs.${Aws.REGION}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*` } },
    }));
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsToSns', principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'], resources: ['*'],
    }));
    const logGroup = (name: string) => new logs.LogGroup(this, `${name}Logs`, {
      logGroupName: `/sdlc-insights/${name.toLowerCase()}`, retention: logs.RetentionDays.TWO_WEEKS, encryptionKey: key, removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------- Storage ----------
    const table = new dynamodb.TableV2(this, 'ChatJobs', {
      tableName: `${prefix}-chat`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand({ maxReadRequestUnits: 200, maxWriteRequestUnits: 100 }),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(key),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logsBucket = new s3.Bucket(this, 'AccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      serverAccessLogsBucket: logsBucket, serverAccessLogsPrefix: 's3-site/', removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    // Holds projectknowledge.md (versioned so every update is retained and auditable).
    const knowledgeBucket = new s3.Bucket(this, 'Knowledge', {
      bucketName: `${prefix}-knowledge-${Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.KMS, encryptionKey: key, bucketKeyEnabled: true,
      enforceSSL: true, versioned: true, serverAccessLogsBucket: logsBucket, serverAccessLogsPrefix: 's3-knowledge/',
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(60) }],
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });

    const originSecret = new secretsmanager.Secret(this, 'OriginVerify', {
      secretName: `${prefix}/origin-verify`, description: 'Header value proving API requests came through CloudFront.',
      encryptionKey: key, generateSecretString: { excludePunctuation: true, passwordLength: 40 }, removalPolicy: RemovalPolicy.DESTROY,
    });
    const originSecretValue = originSecret.secretValue.unsafeUnwrap();

    // ---------- Guardrail for the chatbot ----------
    const f = (type: string, i: string, o: string) => ({ type, inputStrength: i, outputStrength: o });
    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: `${prefix}-guardrail`,
      description: 'Prompt-attack and harmful-content filters for the Class Insights chatbot',
      blockedInputMessaging: 'This question was blocked by the content safety guardrail.',
      blockedOutputsMessaging: 'The answer was blocked by the content safety guardrail.',
      contentPolicyConfig: { filtersConfig: [f('PROMPT_ATTACK', 'HIGH', 'NONE'), f('HATE', 'MEDIUM', 'MEDIUM'), f('INSULTS', 'MEDIUM', 'MEDIUM'), f('SEXUAL', 'HIGH', 'HIGH'), f('VIOLENCE', 'MEDIUM', 'LOW'), f('MISCONDUCT', 'LOW', 'NONE')] },
      sensitiveInformationPolicyConfig: { piiEntitiesConfig: ['AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'PASSWORD', 'EMAIL', 'CREDIT_DEBIT_CARD_NUMBER'].map((type) => ({ type, action: 'ANONYMIZE' })) },
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', { guardrailIdentifier: guardrail.attrGuardrailId, description: 'Pinned version' });

    // ---------- Tool configuration (allow-lists) ----------
    const toolConfig = {
      logGroups: {
        'advisor-api': '/sdlc-advisor/api',
        'advisor-worker': '/sdlc-advisor/worker',
        'advisor-presignup': '/sdlc-advisor/presignup',
        'advisor-api-access': '/sdlc-advisor/apiaccess',
        'insights-api': '/sdlc-insights/api',
        'insights-chat': '/sdlc-insights/chat',
        'insights-api-access': '/sdlc-insights/apiaccess',
      },
      stacks: [
        { name: props.advisorEdgeStackName, region: 'us-east-1', app: 'Secure SDLC Advisor' },
        { name: props.advisorStackName, region: 'us-west-2', app: 'Secure SDLC Advisor' },
        { name: 'SdlcInsightsEdge', region: 'us-east-1', app: 'Class Insights' },
        { name: 'SdlcInsightsApp', region: 'us-west-2', app: 'Class Insights' },
      ],
      knowledgeBucket: knowledgeBucket.bucketName,
      knowledgeKey: 'projectknowledge.md',
      alarmPrefixes: ['sdlc-advisor-', 'sdlc-insights-'],
      functions: { 'advisor-worker': 'sdlc-advisor-worker', 'advisor-api': 'sdlc-advisor-api', 'insights-chat': `${prefix}-chat`, 'insights-api': `${prefix}-api` },
      apis: { advisor: 'sdlc-advisor-api', insights: `${prefix}-api` },
    };

    // Read-only observability permissions shared by both functions. Note: no Secrets Manager, no
    // lambda:GetFunctionConfiguration (env vars) and no CloudFormation template access are granted,
    // so no secret value can be reached through the chatbot or the dashboards.
    const readOnly = [
      new iam.PolicyStatement({
        sid: 'ReadAllowListedLogGroups', actions: ['logs:FilterLogEvents'],
        resources: ['/sdlc-advisor/*', '/sdlc-insights/*'].map((g) => `arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${g}:*`),
      }),
      new iam.PolicyStatement({
        sid: 'ReadClassStacks', actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources', 'cloudformation:DescribeStackEvents'],
        resources: ['us-east-1', 'us-west-2'].flatMap((r) => ['SdlcAdvisor*', 'SdlcInsights*'].map((n) => `arn:aws:cloudformation:${r}:${Aws.ACCOUNT_ID}:stack/${n}/*`)),
      }),
      new iam.PolicyStatement({ sid: 'ReadMetrics', actions: ['cloudwatch:GetMetricData'], resources: ['*'] }),
      // DescribeAlarms with AlarmNamePrefix is authorised against alarm:*, so it cannot be scoped by name; it is read-only metadata.
      new iam.PolicyStatement({ sid: 'ReadAlarms', actions: ['cloudwatch:DescribeAlarms'], resources: [`arn:aws:cloudwatch:${Aws.REGION}:${Aws.ACCOUNT_ID}:alarm:*`] }),
    ];

    const common: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, tracing: lambda.Tracing.ACTIVE,
      environmentEncryption: key, bundling: { minify: true, sourceMap: false, target: 'node24' },
    };

    const chatFn = new nodejs.NodejsFunction(this, 'ChatFn', {
      ...common, functionName: `${prefix}-chat`, entry: path.join(SERVICES, 'chat.ts'), memorySize: 512, timeout: Duration.minutes(3),
      reservedConcurrentExecutions: 20, logGroup: logGroup('Chat'),
      environment: {
        TABLE_NAME: table.tableName, MODEL_ID: props.modelId, GUARDRAIL_ID: guardrail.attrGuardrailId, GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        THINKING_BUDGET_TOKENS: '1024', MAX_OUTPUT_TOKENS: '3000', TOOL_CONFIG: JSON.stringify(toolConfig), SERVICE_NAME: 'sdlc-insights-chat',
      },
    });
    new lambda.EventInvokeConfig(this, 'ChatAsyncConfig', { function: chatFn, retryAttempts: 0, maxEventAge: Duration.minutes(5) });
    table.grant(chatFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    key.grantEncryptDecrypt(chatFn);
    knowledgeBucket.grantRead(chatFn);
    readOnly.forEach((s) => chatFn.addToRolePolicy(s));
    const modelName = props.modelId.replace(/^(us|global|eu|apac)\./, '');
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeSelectedModelOnly', actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${props.modelId}`,
        ...['us-east-1', 'us-east-2', 'us-west-2'].map((r) => `arn:aws:bedrock:${r}::foundation-model/${modelName}`),
      ],
    }));
    chatFn.addToRolePolicy(new iam.PolicyStatement({ sid: 'ApplyGuardrail', actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn] }));

    const apiFn = new nodejs.NodejsFunction(this, 'ApiFn', {
      ...common, functionName: `${prefix}-api`, entry: path.join(SERVICES, 'api.ts'), memorySize: 512, timeout: Duration.seconds(25),
      logGroup: logGroup('Api'),
      environment: { TABLE_NAME: table.tableName, CHAT_FUNCTION_NAME: chatFn.functionName, ORIGIN_VERIFY: originSecretValue, TOOL_CONFIG: JSON.stringify(toolConfig), SERVICE_NAME: 'sdlc-insights-api' },
    });
    table.grant(apiFn, 'dynamodb:GetItem', 'dynamodb:PutItem');
    key.grantEncryptDecrypt(apiFn);
    knowledgeBucket.grantRead(apiFn);
    chatFn.grantInvoke(apiFn);
    readOnly.forEach((s) => apiFn.addToRolePolicy(s));

    // ---------- Cognito: reuse the Advisor's pool (same student accounts), separate app client ----------
    const userPool = cognito.UserPool.fromUserPoolId(this, 'AdvisorUserPool', props.advisorUserPoolId);
    const client = new cognito.UserPoolClient(this, 'WebClient', {
      userPool, userPoolClientName: `${prefix}-web`, generateSecret: false, authFlows: { userPassword: true },
      preventUserExistenceErrors: true, accessTokenValidity: Duration.hours(1), idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1), enableTokenRevocation: true,
    });

    // ---------- API ----------
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefix}-api`, description: 'Class Insights API (via CloudFront only)', endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: false, // the account-level API Gateway logging role is already set by the Advisor stack
      deployOptions: {
        stageName: 'prod', tracingEnabled: true, metricsEnabled: true, dataTraceEnabled: false, loggingLevel: apigw.MethodLoggingLevel.ERROR,
        throttlingRateLimit: 20, throttlingBurstLimit: 40,
        accessLogDestination: new apigw.LogGroupLogDestination(logGroup('ApiAccess')),
        accessLogFormat: apigw.AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId', ip: '$context.identity.sourceIp', method: '$context.httpMethod', path: '$context.resourcePath',
          status: '$context.status', latencyMs: '$context.responseLatency', user: '$context.authorizer.claims.sub',
        })),
        methodOptions: { '/api/chat/POST': { throttlingRateLimit: 3, throttlingBurstLimit: 6 } },
      },
    });
    const integration = new apigw.LambdaIntegration(apiFn, { proxy: true });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', { cognitoUserPools: [userPool], resultsCacheTtl: Duration.minutes(5) });
    const authed: apigw.MethodOptions = { authorizer, authorizationType: apigw.AuthorizationType.COGNITO };
    for (const [id, type] of [['Default4xx', apigw.ResponseType.DEFAULT_4XX], ['Default5xx', apigw.ResponseType.DEFAULT_5XX]] as const) {
      api.addGatewayResponse(id, { type, templates: { 'application/json': '{"error":{"code":"$context.error.responseType","message":$context.error.messageString,"correlationId":"$context.requestId"}}' } });
    }
    const root = api.root.addResource('api');
    root.addResource('health').addMethod('GET', integration);
    for (const r of ['knowledge', 'inventory', 'events', 'logs', 'reasoning', 'metrics', 'sources']) root.addResource(r).addMethod('GET', integration, authed);
    const chat = root.addResource('chat');
    chat.addMethod('POST', integration, authed);
    chat.addResource('{id}').addMethod('GET', integration, authed);

    // ---------- CloudFront ----------
    const cognitoEndpoint = `https://cognito-idp.${Aws.REGION}.amazonaws.com`;
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${prefix}-security-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { override: true, contentSecurityPolicy: ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", `connect-src 'self' ${cognitoEndpoint}`, "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", 'upgrade-insecure-requests'].join('; ') },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: false },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
      },
      customHeadersBehavior: { customHeaders: [
        { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
        { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
      ] },
      removeHeaders: ['Server'],
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'SDLC Class Insights', domainNames: [props.domainName], certificate: props.certificate, webAclId: props.webAclArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021, httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, defaultRootObject: 'index.html',
      enableLogging: true, logBucket: logsBucket, logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, responseHeadersPolicy: headers, compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${api.restApiId}.execute-api.${Aws.REGION}.amazonaws.com`, {
            originPath: '/prod', protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
            customHeaders: { 'x-origin-verify': originSecretValue }, readTimeout: Duration.seconds(30),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZoneName });
    const recordName = props.domainName.replace(`.${props.hostedZoneName}`, '');
    new route53.ARecord(this, 'AliasA', { zone, recordName, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
    new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });

    if (props.frontendDist) {
      new s3deploy.BucketDeployment(this, 'DeploySite', {
        destinationBucket: siteBucket,
        sources: [
          s3deploy.Source.asset(props.frontendDist),
          s3deploy.Source.jsonData('config.json', { region: Aws.REGION, userPoolId: props.advisorUserPoolId, userPoolClientId: client.userPoolClientId, modelId: props.modelId, advisorUrl: props.advisorUrl }),
        ],
        distribution, distributionPaths: ['/*'], memoryLimit: 512, prune: true,
      });
    }

    // ---------- Monitoring ----------
    const topic = new sns.Topic(this, 'Alarms', { topicName: `${prefix}-alarms`, masterKey: key, enforceSSL: true });
    const m = (metricName: string, statistic = 'Sum') => new cw.Metric({ namespace: 'SdlcClassInsights', metricName, statistic, period: Duration.minutes(5) });
    const alarmList = [
      new cw.Alarm(this, 'ChatFailures', { alarmName: `${prefix}-chat-failures`, metric: m('ChatFailures'), threshold: 3, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
      new cw.Alarm(this, 'ChatFnErrors', { alarmName: `${prefix}-chat-fn-errors`, metric: chatFn.metricErrors({ period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
      new cw.Alarm(this, 'ApiFnErrors', { alarmName: `${prefix}-api-fn-errors`, metric: apiFn.metricErrors({ period: Duration.minutes(5) }), threshold: 3, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
      new cw.Alarm(this, 'Api5xx', { alarmName: `${prefix}-api-5xx`, metric: api.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }), threshold: 5, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING }),
    ];
    alarmList.forEach((a) => a.addAlarmAction(new cwActions.SnsAction(topic)));
    const dash = new cw.Dashboard(this, 'Dashboard', { dashboardName: `${prefix}-operations` });
    dash.addWidgets(
      new cw.AlarmStatusWidget({ title: 'Alarms', alarms: alarmList, width: 8, height: 6 }),
      new cw.GraphWidget({ title: 'Chat questions / failures', width: 8, left: [m('ChatQuestions'), m('ChatFailures'), m('ChatGuardrailBlocks')] }),
      new cw.GraphWidget({ title: 'Chat tokens (incl. prompt-cache reads)', width: 8, left: [m('InputTokens'), m('OutputTokens'), m('CacheReadTokens')] }),
      new cw.GraphWidget({ title: 'Chat duration (ms)', width: 8, left: [m('ChatDurationMs', 'Average'), m('ChatDurationMs', 'p90')] }),
      new cw.GraphWidget({ title: 'API requests / errors', width: 8, left: [api.metricCount()], right: [api.metricClientError(), api.metricServerError()] }),
      new cw.GraphWidget({ title: 'Tool calls per answer', width: 8, left: [m('ToolCalls', 'Average')] }),
    );

    new CfnOutput(this, 'Url', { value: `https://${props.domainName}` });
    new CfnOutput(this, 'KnowledgeBucket', { value: knowledgeBucket.bucketName });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'ApiId', { value: api.restApiId });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId });
  }
}
