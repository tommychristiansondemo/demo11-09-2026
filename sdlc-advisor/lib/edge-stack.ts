import { Stack, StackProps, Tags, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface EdgeStackProps extends StackProps {
  domainName: string;
  hostedZoneName: string;
}

/** Resources that must live in us-east-1 for CloudFront: ACM certificate and the CLOUDFRONT-scope WAF web ACL. */
export class EdgeStack extends Stack {
  public readonly certificate: acm.ICertificate;
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    Tags.of(this).add('project', 'secure-sdlc-advisor');

    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZoneName });
    this.certificate = new acm.Certificate(this, 'Cert', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const managed = (name: string, priority: number, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: overrides.map((o) => ({ name: o, actionToUse: { count: {} } })),
        },
      },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
    });

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: 'sdlc-advisor-web-acl',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'sdlc-advisor-web-acl', sampledRequestsEnabled: true },
      rules: [
        {
          // A whole classroom may share one NAT IP, so this is generous.
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 3000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp', sampledRequestsEnabled: true },
        },
        {
          name: 'ApiBodySizeLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            andStatement: {
              statements: [
                { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: '/api/', textTransformations: [{ priority: 0, type: 'NONE' }] } },
                { sizeConstraintStatement: { fieldToMatch: { body: { oversizeHandling: 'MATCH' } }, comparisonOperator: 'GT', size: 16000, textTransformations: [{ priority: 0, type: 'NONE' }] } },
              ],
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'ApiBodySizeLimit', sampledRequestsEnabled: true },
        },
        managed('AWSManagedRulesAmazonIpReputationList', 2),
        // SizeRestrictions_BODY (8 KB) is replaced by the explicit 16 KB rule above.
        // CrossSiteScripting_BODY is counted rather than blocked because users legitimately
        // describe XSS/SQLi threats in prose; the API validates, encodes and never renders HTML.
        managed('AWSManagedRulesCommonRuleSet', 3, ['SizeRestrictions_BODY', 'CrossSiteScripting_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 4),
      ],
    });
    this.webAclArn = acl.attrArn;

    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn });
  }
}
