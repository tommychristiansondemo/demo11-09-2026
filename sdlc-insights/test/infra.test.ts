import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { EdgeStack } from '../lib/edge-stack';
import { InsightsAppStack } from '../lib/app-stack';

const account = '123456789012';
const z = (r: string) => ({ [`hosted-zone:account=${account}:domainName=example.com:region=${r}`]: { Id: '/hostedzone/Z1', Name: 'example.com.' } });
const app = new App({ context: { ...z('us-east-1'), ...z('us-west-2') } });
const edge = new EdgeStack(app, 'E', { env: { account, region: 'us-east-1' }, crossRegionReferences: true, domainName: 'sdlc-insights.example.com', hostedZoneName: 'example.com' });
const stack = new InsightsAppStack(app, 'A', {
  env: { account, region: 'us-west-2' }, crossRegionReferences: true, domainName: 'sdlc-insights.example.com', hostedZoneName: 'example.com',
  certificate: edge.certificate, webAclArn: edge.webAclArn, modelId: 'us.anthropic.claude-sonnet-4-6', advisorUserPoolId: 'us-west-2_abc',
  advisorUrl: 'https://demo.example.com', advisorStackName: 'SdlcAdvisorApp', advisorEdgeStackName: 'SdlcAdvisorEdge',
});
const t = Template.fromStack(stack);
const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
const actions = statements.flatMap((s) => [].concat(s.Action));

describe('Class Insights security posture', () => {
  it('grants no way to read secrets, Lambda env vars or templates', () => {
    for (const forbidden of ['secretsmanager:GetSecretValue', 'lambda:GetFunctionConfiguration', 'lambda:GetFunction', 'cloudformation:GetTemplate', 'ssm:GetParameter', 'kms:*', 's3:*', 'logs:*']) {
      expect(actions).not.toContain(forbidden);
    }
  });
  it('limits log reads to the two applications', () => {
    const logStmt = statements.find((s) => s.Sid === 'ReadAllowListedLogGroups');
    const res = JSON.stringify(logStmt.Resource);
    expect(res).toContain('/sdlc-advisor/*');
    expect(res).toContain('/sdlc-insights/*');
    expect(res).not.toContain('/aws/lambda');
  });
  it('stores the knowledge doc in a versioned, KMS-encrypted, private bucket', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) })] },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
  });
  it('protects all data routes with Cognito', () => {
    const methods = Object.values(t.findResources('AWS::ApiGateway::Method')).filter((m) => m.Properties.HttpMethod !== 'OPTIONS');
    expect(methods.filter((m) => m.Properties.AuthorizationType !== 'COGNITO_USER_POOLS').length).toBe(1); // health only
  });
  it('uses WAF + TLS1.2 on CloudFront and a guardrail for the chatbot', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue(), ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' }) }) });
    t.hasResourceProperties('AWS::Bedrock::Guardrail', { ContentPolicyConfig: { FiltersConfig: Match.arrayWith([Match.objectLike({ Type: 'PROMPT_ATTACK' })]) } });
  });
});
