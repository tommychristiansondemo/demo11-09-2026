import { Stack, Validations } from 'aws-cdk-lib';

// Reviewed cdk-nag (AwsSolutions) acknowledgments for Class Insights. NAG_RAW=1 shows the raw findings.
const N = (r: string) => `AwsSolutions::AwsSolutions-${r}`;

export function applyNagSuppressions(app: Stack) {
  if (process.env.NAG_RAW) return;
  const iam5 = (items: string[], reason: string) => items.map((x) => ({ id: `${N('IAM5')}[${x}]`, reason }));
  const acks = [
    { id: `${N('IAM4')}[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]`, reason: 'AWS-recommended minimal managed policy for Lambda log delivery.' },
    ...iam5(['Resource::*'], 'cloudwatch:GetMetricData and X-Ray PutTraceSegments do not support resource-level permissions.'),
    ...iam5(['Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*'], 'KMS action families granted on the single Class Insights CMK only.'),
    ...iam5(['Action::s3:GetBucket*', 'Action::s3:GetObject*', 'Action::s3:List*', 'Resource::<KnowledgeB6F5C7B3.Arn>/*'], 'Read-only access to the knowledge bucket (projectknowledge.md) only.'),
    ...iam5(['us-east-1', 'us-west-2'].flatMap((r) => ['SdlcAdvisor', 'SdlcInsights'].map((n) => `Resource::arn:aws:cloudformation:${r}:<AWS::AccountId>:stack/${n}*/*`)),
      'Read-only CloudFormation describe/list on the four class stacks; the trailing wildcard is the stack-id suffix CloudFormation appends to every stack ARN.'),
    ...iam5(['Resource::arn:aws:cloudwatch:<AWS::Region>:<AWS::AccountId>:alarm:*'], 'cloudwatch:DescribeAlarms (read-only) is authorised against alarm:* when AlarmNamePrefix is used; the code only queries the two applications\' prefixes.'),
    ...iam5(['/sdlc-advisor/*:*', '/sdlc-insights/*:*'].map((g) => `Resource::arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:${g}`), 'logs:FilterLogEvents limited to the two applications\' log-group prefixes (never /aws/lambda or other apps).'),
    ...iam5(['Resource::<ChatFn5A5B3E47.Arn>:*'], 'Invoke versions/aliases of the single chat function only.'),
    ...iam5(['Action::s3:Abort*', 'Action::s3:DeleteObject*', 'Resource::<SiteE53D7754.Arn>/*', `Resource::arn:<AWS::Partition>:s3:::cdk-sdlcins-assets-${app.account}-${app.region}/*`],
      'CDK-managed BucketDeployment helper scoped to the site bucket and the CDK asset bucket.'),
    { id: N('L1'), reason: 'Application functions use Node.js 24; the remaining finding is the CDK-managed BucketDeployment provider runtime.' },
    { id: N('APIG2'), reason: 'Request validation is implemented and unit-tested in the Lambda (allow-listed fields, lengths, alternating history).' },
    { id: N('APIG3'), reason: 'API is only reachable through CloudFront + WAF; direct calls are rejected by the origin-verify check.' },
    { id: N('APIG4'), reason: '/api/health is intentionally unauthenticated and returns no data; all other routes use the Cognito authorizer.' },
    { id: N('COG4'), reason: '/api/health is intentionally unauthenticated and returns no data; all other routes use the Cognito authorizer.' },
    { id: N('SMG4'), reason: 'Origin-verify secret is a static CloudFront custom header; rotation is out of scope for a one-day demo.' },
    { id: N('CFR1'), reason: 'No geo restriction: students may attend from any location.' },
  ];
  acks.forEach((a) => Validations.of(app).acknowledge(a));
}
