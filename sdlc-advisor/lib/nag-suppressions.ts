import { Stack, Validations } from 'aws-cdk-lib';

// cdk-nag (AwsSolutions pack) findings that are accepted for this demo. Every acknowledgment carries a reason
// and is reviewed as part of the security validation step. Set NAG_RAW=1 to see unacknowledged findings.
type Ack = { id: string; reason: string };
const ack = (scope: Stack, items: Ack[]) => items.forEach((i) => Validations.of(scope).acknowledge(i));
const N = (rule: string) => `AwsSolutions::AwsSolutions-${rule}`;

export function applyNagSuppressions(_edge: Stack, app: Stack) {
  if (process.env.NAG_RAW) return;
  ack(app, [
    ...[
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
    ].map((p) => ({ id: `${N('IAM4')}[${p}]`, reason: 'AWS-recommended minimal managed policies: Lambda log delivery and API Gateway account-level log push.' })),
    { id: `${N('IAM5')}[Resource::*]`, reason: 'X-Ray PutTraceSegments/PutTelemetryRecords do not support resource-level permissions.' },
    ...['Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*'].map((a) => ({ id: `${N('IAM5')}[${a}]`, reason: 'KMS action families granted by grantEncryptDecrypt on the single application CMK only.' })),
    { id: `${N('IAM5')}[Resource::<WorkerFn847949AF.Arn>:*]`, reason: 'Allows invoking versions/aliases of the single worker function only.' },
    ...['Action::s3:Abort*', 'Action::s3:DeleteObject*', 'Action::s3:GetBucket*', 'Action::s3:GetObject*', 'Action::s3:List*',
      `Resource::arn:<AWS::Partition>:s3:::cdk-sdlcadv-assets-${app.account}-${app.region}/*`, 'Resource::<SiteE53D7754.Arn>/*']
      .map((x) => ({ id: `${N('IAM5')}[${x}]`, reason: 'CDK-managed BucketDeployment helper, scoped to the CDK asset bucket and the site bucket.' })),
    { id: N('L1'), reason: 'Application functions use Node.js 24 (latest). The remaining finding is the CDK-managed BucketDeployment provider whose runtime is controlled by aws-cdk-lib.' },
    { id: N('COG1'), reason: 'Demo requirement: password policy intentionally set to the Cognito minimum (6 characters, no complexity). Production must use a strong policy.' },
    { id: N('COG2'), reason: 'Demo requirement: MFA disabled so students can self-register many test accounts quickly. Production must enable MFA.' },
    { id: N('COG8'), reason: 'Cognito Plus tier (threat protection) incurs per-MAU cost and is not justified for a one-day class; WAF rate limiting and API throttling provide abuse protection.' },
    { id: N('APIG2'), reason: 'Request validation is implemented in the Lambda (strict allow-list schema, size limits, unit-tested) to keep rules in one place.' },
    { id: N('APIG3'), reason: 'The API is fronted by CloudFront with an AWS WAF web ACL; direct execute-api calls are rejected by the origin-verify header check.' },
    { id: N('APIG4'), reason: '/api/health is intentionally unauthenticated for Route 53 health checks and returns no data; all other routes use the Cognito authorizer.' },
    { id: N('COG4'), reason: '/api/health is intentionally unauthenticated for Route 53 health checks and returns no data; all other routes use the Cognito authorizer.' },
    { id: N('SMG4'), reason: 'The origin-verify secret is consumed by CloudFront as a static custom header; rotation needs a coordinated redeploy and is out of scope for a one-day demo.' },
    { id: N('CFR1'), reason: 'No geo restriction: students may attend from any location.' },
  ]);
}
