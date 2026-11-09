import * as path from 'node:path';
import { Stack, StackProps, Duration, RemovalPolicy, Tags, CfnOutput, Aws } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
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
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface AppStackProps extends StackProps {
  domainName: string;
  hostedZoneName: string;
  certificate: acm.ICertificate;
  webAclArn: string;
  modelId: string;
  historyTtlDays: number;
  alarmEmail?: string;
  insightsUrl?: string;
  frontendDist?: string; // omit in unit tests
}

const SERVICES = path.join(__dirname, '..', 'services', 'src');

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    Tags.of(this).add('project', 'secure-sdlc-advisor');
    const prefix = 'sdlc-advisor';

    // ---------- Encryption ----------
    const key = new kms.Key(this, 'DataKey', {
      alias: `alias/${prefix}`,
      description: 'Secure SDLC Advisor data, logs and audit trail',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs',
      principals: [new iam.ServicePrincipal(`logs.${Aws.REGION}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*` } },
    }));
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsToSns',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));

    const logGroup = (name: string) => new logs.LogGroup(this, `${name}Logs`, {
      logGroupName: `/sdlc-advisor/${name.toLowerCase()}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      encryptionKey: key,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------- Storage ----------
    const table = new dynamodb.TableV2(this, 'Assessments', {
      tableName: `${prefix}-assessments`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'assessmentId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand({ maxReadRequestUnits: 200, maxWriteRequestUnits: 100 }),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(key),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logsBucket = new s3.Bucket(this, 'AccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // required by CloudFront standard logging
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 's3-site/',
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Audit ----------
    const trailBucket = new s3.Bucket(this, 'TrailBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      enforceSSL: true,
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 's3-trail/',
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // CDK only adds the CloudTrail bucket policy when it creates the bucket itself, so add it explicitly.
    const trailName = `${prefix}-trail`;
    const trailArn = `arn:aws:cloudtrail:${Aws.REGION}:${Aws.ACCOUNT_ID}:trail/${trailName}`;
    trailBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudTrailAclCheck',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [trailBucket.bucketArn],
      conditions: { StringEquals: { 'aws:SourceArn': trailArn } },
    }));
    trailBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudTrailWrite',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [trailBucket.arnForObjects(`AWSLogs/${Aws.ACCOUNT_ID}/*`)],
      conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': trailArn } },
    }));
    key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudTrailBucketEncryption',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceArn': trailArn } },
    }));
    const trail = new cloudtrail.Trail(this, 'Trail', {
      trailName,
      bucket: trailBucket,
      encryptionKey: key,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
    });
    trail.node.addDependency(trailBucket.policy!);

    // ---------- Origin verification secret (CloudFront -> API Gateway) ----------
    const originSecret = new secretsmanager.Secret(this, 'OriginVerify', {
      secretName: `${prefix}/origin-verify`,
      description: 'Shared header value proving API requests came through CloudFront (and therefore WAF).',
      encryptionKey: key,
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const originSecretValue = originSecret.secretValue.unsafeUnwrap(); // CloudFormation dynamic reference

    // ---------- Bedrock guardrail ----------
    const filter = (type: string, input: string, output: string) => ({ type, inputStrength: input, outputStrength: output });
    const pii = (type: string) => ({ type, action: 'ANONYMIZE' });
    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: `${prefix}-guardrail`,
      description: 'Prompt-attack, harmful-content and secret/PII filters for Secure SDLC Advisor',
      blockedInputMessaging: 'This request was blocked by the content safety guardrail.',
      blockedOutputsMessaging: 'The response was blocked by the content safety guardrail.',
      contentPolicyConfig: {
        filtersConfig: [
          filter('PROMPT_ATTACK', 'HIGH', 'NONE'),
          filter('HATE', 'MEDIUM', 'MEDIUM'),
          filter('INSULTS', 'MEDIUM', 'MEDIUM'),
          filter('SEXUAL', 'HIGH', 'HIGH'),
          // Security assessments legitimately discuss attacks, so violence/misconduct are kept low.
          filter('VIOLENCE', 'MEDIUM', 'LOW'),
          filter('MISCONDUCT', 'LOW', 'NONE'),
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: ['EMAIL', 'PHONE', 'US_SOCIAL_SECURITY_NUMBER', 'CREDIT_DEBIT_CARD_NUMBER', 'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'PASSWORD'].map(pii),
      },
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Pinned version used by the worker',
    });

    // ---------- Lambda functions ----------
    const common: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      environmentEncryption: key,
      bundling: { minify: true, sourceMap: false, target: 'node24' },
    };

    const workerFn = new nodejs.NodejsFunction(this, 'WorkerFn', {
      ...common,
      functionName: `${prefix}-worker`,
      entry: path.join(SERVICES, 'worker.ts'),
      memorySize: 512,
      timeout: Duration.minutes(5),
      reservedConcurrentExecutions: 25, // cost guard-rail for Bedrock spend
      logGroup: logGroup('Worker'),
      environment: {
        TABLE_NAME: table.tableName,
        MODEL_ID: props.modelId,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        MAX_OUTPUT_TOKENS: '10000',
        THINKING_BUDGET_TOKENS: '2048',
        SERVICE_NAME: 'sdlc-advisor-worker',
      },
    });
    new lambda.EventInvokeConfig(this, 'WorkerAsyncConfig', { function: workerFn, retryAttempts: 0, maxEventAge: Duration.minutes(10) });
    table.grant(workerFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    key.grantEncryptDecrypt(workerFn);
    const modelName = props.modelId.replace(/^(us|global|eu|apac)\./, '');
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeSelectedModelOnly',
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${props.modelId}`,
        // The US cross-region inference profile routes to these three regions only.
        ...['us-east-1', 'us-east-2', 'us-west-2'].map((r) => `arn:aws:bedrock:${r}::foundation-model/${modelName}`),
      ],
    }));
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ApplyGuardrail',
      actions: ['bedrock:ApplyGuardrail'],
      resources: [guardrail.attrGuardrailArn],
    }));

    const apiFn = new nodejs.NodejsFunction(this, 'ApiFn', {
      ...common,
      functionName: `${prefix}-api`,
      entry: path.join(SERVICES, 'api.ts'),
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: logGroup('Api'),
      environment: {
        TABLE_NAME: table.tableName,
        WORKER_FUNCTION_NAME: workerFn.functionName,
        HISTORY_TTL_DAYS: String(props.historyTtlDays),
        ORIGIN_VERIFY: originSecretValue,
        APP_VERSION: '1.0.0',
        SERVICE_NAME: 'sdlc-advisor-api',
      },
    });
    table.grant(apiFn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:DeleteItem');
    key.grantEncryptDecrypt(apiFn);
    workerFn.grantInvoke(apiFn);

    const preSignUpFn = new nodejs.NodejsFunction(this, 'PreSignUpFn', {
      ...common,
      functionName: `${prefix}-presignup`,
      entry: path.join(SERVICES, 'presignup.ts'),
      memorySize: 128,
      timeout: Duration.seconds(5),
      logGroup: logGroup('PreSignUp'),
    });

    // ---------- Cognito (demo-grade password policy; self-service sign-up, no verification) ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { username: true },
      signInCaseSensitive: false,
      autoVerify: {},
      passwordPolicy: {
        minLength: 6, // Cognito minimum
        requireDigits: false,
        requireLowercase: false,
        requireUppercase: false,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(1),
      },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.NONE,
      lambdaTriggers: { preSignUp: preSignUpFn },
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
    });
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: `${prefix}-web`,
      generateSecret: false,
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
    });

    // ---------- API Gateway ----------
    const accessLogs = logGroup('ApiAccess');
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefix}-api`,
      description: 'Secure SDLC Advisor API (reached via CloudFront only)',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false, // never log request/response bodies
        throttlingRateLimit: 25,
        throttlingBurstLimit: 50,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          method: '$context.httpMethod',
          path: '$context.resourcePath',
          status: '$context.status',
          latencyMs: '$context.responseLatency',
          integrationLatencyMs: '$context.integrationLatency',
          bytes: '$context.responseLength',
          user: '$context.authorizer.claims.sub',
          wafError: '$context.waf.error',
        })),
        methodOptions: {
          '/api/assessments/POST': { throttlingRateLimit: 5, throttlingBurstLimit: 10 },
        },
      },
    });

    // Lambda rejects requests that lack the CloudFront origin-verify header (see api.ts).
    const integration = new apigw.LambdaIntegration(apiFn, { proxy: true });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
      authorizerName: `${prefix}-cognito`,
      resultsCacheTtl: Duration.minutes(5),
    });
    const authed: apigw.MethodOptions = { authorizer, authorizationType: apigw.AuthorizationType.COGNITO };

    const jsonError = (type: apigw.ResponseType, id: string) => api.addGatewayResponse(id, {
      type,
      templates: { 'application/json': '{"error":{"code":"$context.error.responseType","message":$context.error.messageString,"correlationId":"$context.requestId"}}' },
      responseHeaders: { 'Cache-Control': "'no-store'" },
    });
    jsonError(apigw.ResponseType.DEFAULT_4XX, 'Default4xx');
    jsonError(apigw.ResponseType.DEFAULT_5XX, 'Default5xx');

    const apiRoot = api.root.addResource('api');
    apiRoot.addResource('health').addMethod('GET', integration);
    const assessments = apiRoot.addResource('assessments');
    assessments.addMethod('GET', integration, authed);
    assessments.addMethod('POST', integration, authed);
    const one = assessments.addResource('{id}');
    one.addMethod('GET', integration, authed);
    one.addMethod('DELETE', integration, authed);

    // ---------- CloudFront ----------
    const cognitoEndpoint = `https://cognito-idp.${Aws.REGION}.amazonaws.com`;
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${prefix}-security-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self'",
            `connect-src 'self' ${cognitoEndpoint}`,
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            'upgrade-insecure-requests',
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: false, preload: false },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
        xssProtection: { override: true, protection: false },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
        ],
      },
      removeHeaders: ['Server'],
    });

    const apiOrigin = new origins.HttpOrigin(`${api.restApiId}.execute-api.${Aws.REGION}.amazonaws.com`, {
      originPath: `/${api.deploymentStage.stageName}`,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      customHeaders: { 'x-origin-verify': originSecretValue },
      readTimeout: Duration.seconds(30),
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Secure SDLC Advisor',
      domainNames: [props.domainName],
      certificate: props.certificate,
      webAclId: props.webAclArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });

    // ---------- DNS ----------
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZoneName });
    const recordName = props.domainName.replace(new RegExp(`\\.?${props.hostedZoneName.replace(/\./g, '\\.')}$`), '');
    new route53.ARecord(this, 'AliasA', { zone, recordName, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
    new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });

    const healthCheck = new route53.CfnHealthCheck(this, 'HealthCheck', {
      healthCheckConfig: {
        type: 'HTTPS',
        fullyQualifiedDomainName: props.domainName,
        resourcePath: '/api/health',
        port: 443,
        requestInterval: 30,
        failureThreshold: 3,
        enableSni: true,
      },
      healthCheckTags: [{ key: 'Name', value: `${prefix}-health` }],
    });

    // ---------- Frontend deployment ----------
    if (props.frontendDist) {
      new s3deploy.BucketDeployment(this, 'DeploySite', {
        destinationBucket: siteBucket,
        sources: [
          s3deploy.Source.asset(props.frontendDist),
          s3deploy.Source.jsonData('config.json', {
            region: Aws.REGION,
            userPoolId: userPool.userPoolId,
            userPoolClientId: userPoolClient.userPoolClientId,
            modelId: props.modelId,
            historyTtlDays: props.historyTtlDays,
            insightsUrl: props.insightsUrl ?? '',
          }),
        ],
        distribution,
        distributionPaths: ['/*'],
        memoryLimit: 512,
        prune: true,
      });
    }

    // ---------- Monitoring ----------
    const topic = new sns.Topic(this, 'Alarms', { topicName: `${prefix}-alarms`, masterKey: key, enforceSSL: true });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const alarmAction = new cwActions.SnsAction(topic);

    const custom = (metricName: string, statistic = 'Sum') =>
      new cw.Metric({ namespace: 'SecureSdlcAdvisor', metricName, statistic, period: Duration.minutes(5) });

    const alarms = [
      new cw.Alarm(this, 'Api5xxAlarm', {
        alarmName: `${prefix}-api-5xx`,
        metric: api.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, 'ApiLatencyAlarm', {
        alarmName: `${prefix}-api-latency-p90`,
        metric: api.metricLatency({ period: Duration.minutes(5), statistic: 'p90' }),
        threshold: 3000, evaluationPeriods: 3, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, 'ApiFnErrorsAlarm', {
        alarmName: `${prefix}-api-fn-errors`,
        metric: apiFn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 3, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, 'WorkerErrorsAlarm', {
        alarmName: `${prefix}-worker-errors`,
        metric: workerFn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, 'WorkerThrottlesAlarm', {
        alarmName: `${prefix}-worker-throttles`,
        metric: workerFn.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, 'AssessmentFailuresAlarm', {
        alarmName: `${prefix}-assessment-failures`,
        metric: custom('AssessmentsFailed'),
        threshold: 3, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    ];
    alarms.forEach((a) => a.addAlarmAction(alarmAction));

    const edgeMetric = (namespace: string, metricName: string, dimensionsMap: Record<string, string>, statistic = 'Sum', label?: string) =>
      new cw.Metric({ namespace, metricName, dimensionsMap, statistic, region: 'us-east-1', period: Duration.minutes(5), label });

    const dashboard = new cw.Dashboard(this, 'Dashboard', { dashboardName: `${prefix}-operations` });
    dashboard.addWidgets(
      new cw.TextWidget({ markdown: `# Secure SDLC Advisor — operations\nhttps://${props.domainName} · model \`${props.modelId}\` · training demo (synthetic data only)`, width: 24, height: 2 }),
    );
    dashboard.addWidgets(
      new cw.AlarmStatusWidget({ title: 'Alarms', alarms, width: 8, height: 6 }),
      new cw.GraphWidget({ title: 'Assessments', width: 8, left: [custom('AssessmentsRequested'), custom('AssessmentsCompleted'), custom('AssessmentsFailed'), custom('GuardrailBlocks')] }),
      new cw.GraphWidget({ title: 'Assessment duration (ms)', width: 8, left: [custom('AssessmentDurationMs', 'Average'), custom('AssessmentDurationMs', 'p90')] }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: 'API requests / errors', width: 8, left: [api.metricCount({ period: Duration.minutes(5) })], right: [api.metricClientError({ period: Duration.minutes(5) }), api.metricServerError({ period: Duration.minutes(5) })] }),
      new cw.GraphWidget({ title: 'API latency (ms)', width: 8, left: [api.metricLatency({ statistic: 'p50' }), api.metricLatency({ statistic: 'p90' })] }),
      new cw.GraphWidget({ title: 'Bedrock tokens', width: 8, left: [custom('InputTokens'), custom('OutputTokens')] }),
    );
    dashboard.addWidgets(
      new cw.GraphWidget({ title: 'Lambda errors / throttles', width: 8, left: [apiFn.metricErrors(), workerFn.metricErrors(), workerFn.metricThrottles()] }),
      new cw.GraphWidget({ title: 'Worker concurrency', width: 8, left: [workerFn.metric('ConcurrentExecutions', { statistic: 'Maximum' })] }),
      new cw.GraphWidget({
        title: 'Edge: WAF + CloudFront + health check',
        width: 8,
        left: [
          edgeMetric('AWS/WAFV2', 'BlockedRequests', { WebACL: 'sdlc-advisor-web-acl', Rule: 'ALL' }, 'Sum', 'WAF blocked'),
          edgeMetric('AWS/CloudFront', '5xxErrorRate', { DistributionId: distribution.distributionId, Region: 'Global' }, 'Average', 'CloudFront 5xx %'),
        ],
        right: [edgeMetric('AWS/Route53', 'HealthCheckStatus', { HealthCheckId: healthCheck.attrHealthCheckId }, 'Minimum', 'Health (1 = healthy)')],
      }),
    );

    // ---------- Outputs ----------
    new CfnOutput(this, 'Url', { value: `https://${props.domainName}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'ApiId', { value: api.restApiId });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId });
    new CfnOutput(this, 'DashboardName', { value: `${prefix}-operations` });
    new CfnOutput(this, 'SiteBucket', { value: siteBucket.bucketName });
  }
}
