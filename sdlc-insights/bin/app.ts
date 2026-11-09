#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { EdgeStack } from '../lib/edge-stack';
import { InsightsAppStack } from '../lib/app-stack';
import { applyNagSuppressions } from '../lib/nag-suppressions';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const ctx = (k: string) => app.node.tryGetContext(k);
const advisorUserPoolId: string = ctx('advisorUserPoolId');
if (!advisorUserPoolId) throw new Error('Pass -c advisorUserPoolId=<pool id> (scripts/deploy.sh reads it from the Advisor stack outputs)');
const dist = path.join(__dirname, '..', 'frontend', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the frontend first: npm --prefix frontend run build');

const edge = new EdgeStack(app, 'SdlcInsightsEdge', {
  env: { account, region: 'us-east-1' }, crossRegionReferences: true, domainName: ctx('domainName'), hostedZoneName: ctx('hostedZoneName'),
  description: 'SDLC Class Insights - ACM certificate and CloudFront WAF (us-east-1)',
});
const stack = new InsightsAppStack(app, 'SdlcInsightsApp', {
  env: { account, region: 'us-west-2' }, crossRegionReferences: true,
  domainName: ctx('domainName'), hostedZoneName: ctx('hostedZoneName'), certificate: edge.certificate, webAclArn: edge.webAclArn,
  modelId: ctx('modelId'), advisorUserPoolId, advisorUrl: ctx('advisorUrl') ?? 'https://demo.awsteach.com',
  advisorStackName: ctx('advisorStackName'), advisorEdgeStackName: ctx('advisorEdgeStackName'), frontendDist: dist,
  description: 'SDLC Class Insights - chatbot and live deployment insights (us-west-2)',
});
stack.addDependency(edge);
applyNagSuppressions(stack);
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
