import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { EdgeStack } from '../lib/edge-stack';
import { AppStack } from '../lib/app-stack';

const account = '123456789012';
const zoneCtx = (region: string) => ({ [`hosted-zone:account=${account}:domainName=example.com:region=${region}`]: { Id: '/hostedzone/Z123', Name: 'example.com.' } });

function synth() {
  const app = new App({ context: { ...zoneCtx('us-east-1'), ...zoneCtx('us-west-2') } });
  const edge = new EdgeStack(app, 'Edge', { env: { account, region: 'us-east-1' }, crossRegionReferences: true, domainName: 'demo.example.com', hostedZoneName: 'example.com' });
  const stack = new AppStack(app, 'App', {
    env: { account, region: 'us-west-2' }, crossRegionReferences: true, domainName: 'demo.example.com', hostedZoneName: 'example.com',
    certificate: edge.certificate, webAclArn: edge.webAclArn, modelId: 'us.anthropic.claude-sonnet-4-6', historyTtlDays: 7,
  });
  return { edge: Template.fromStack(edge), app: Template.fromStack(stack) };
}
const t = synth();

describe('edge stack', () => {
  it('creates a DNS-validated certificate and a CloudFront-scope WAF with managed rules and rate limiting', () => {
    t.edge.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'demo.example.com', ValidationMethod: 'DNS' });
    t.edge.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'RateLimitPerIp' }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'AWSManagedRulesKnownBadInputsRuleSet' }),
      ]),
    });
  });
});

describe('app stack', () => {
  it('encrypts DynamoDB with a CMK and enables TTL', () => {
    t.app.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
    });
    t.app.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('uses a demo-grade Cognito pool: self sign-up, 6-char minimum, no verification', () => {
    t.app.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 6, RequireUppercase: false, RequireNumbers: false, RequireSymbols: false, RequireLowercase: false }) },
      AutoVerifiedAttributes: [],
      LambdaConfig: { PreSignUp: Match.anyValue() },
    });
  });

  it('protects every API method except health with Cognito, and never logs bodies', () => {
    const methods = t.app.findResources('AWS::ApiGateway::Method');
    const nonOptions = Object.values(methods).filter((m) => m.Properties.HttpMethod !== 'OPTIONS');
    expect(nonOptions.length).toBe(5);
    expect(nonOptions.filter((m) => m.Properties.AuthorizationType === 'COGNITO_USER_POOLS').length).toBe(4);
    t.app.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([Match.objectLike({ DataTraceEnabled: false, ThrottlingRateLimit: 25 })]),
    });
  });

  it('serves the site over TLS 1.2+ with WAF and strict security headers', () => {
    t.app.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: Match.anyValue(),
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' }),
        Aliases: ['demo.example.com'],
      }),
    });
    t.app.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
                    StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000 }),
          FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
        }),
      }),
    });
  });

  it('sends a CSP that blocks framing and inline scripts', () => {
    const csp = JSON.stringify(Object.values(t.app.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('grants the worker Bedrock access to the selected model only', () => {
    const policies = Object.values(t.app.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const bedrock = statements.filter((s) => JSON.stringify(s.Action).includes('bedrock:'));
    expect(bedrock.length).toBeGreaterThan(0);
    for (const s of bedrock) {
      expect(JSON.stringify(s.Action)).not.toContain('bedrock:*');
      expect(JSON.stringify(s.Resource)).not.toMatch(/"\*"/);
    }
  });

  it('creates a Bedrock guardrail with prompt-attack filtering and a pinned version', () => {
    t.app.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContentPolicyConfig: { FiltersConfig: Match.arrayWith([Match.objectLike({ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH' })]) },
    });
    t.app.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
  });

  it('enables CloudTrail with log validation, alarms and a dashboard', () => {
    t.app.hasResourceProperties('AWS::CloudTrail::Trail', { EnableLogFileValidation: true, IsMultiRegionTrail: true });
    expect(Object.keys(t.app.findResources('AWS::CloudWatch::Alarm')).length).toBeGreaterThanOrEqual(5);
    t.app.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  it('creates DNS alias records and a health check', () => {
    t.app.resourceCountIs('AWS::Route53::RecordSet', 2);
    t.app.hasResourceProperties('AWS::Route53::HealthCheck', { HealthCheckConfig: Match.objectLike({ ResourcePath: '/api/health', Type: 'HTTPS' }) });
  });
});
