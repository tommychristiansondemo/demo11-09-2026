#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { EdgeStack } from '../lib/edge-stack';
import { AppStack } from '../lib/app-stack';
import { applyNagSuppressions } from '../lib/nag-suppressions';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const domainName: string = app.node.tryGetContext('domainName');
const hostedZoneName: string = app.node.tryGetContext('hostedZoneName');
const modelId: string = app.node.tryGetContext('modelId');
const historyTtlDays = Number(app.node.tryGetContext('historyTtlDays') ?? 7);
const alarmEmail: string | undefined = app.node.tryGetContext('alarmEmail');
const insightsUrl: string = app.node.tryGetContext('insightsUrl') ?? '';

const dist = path.join(__dirname, '..', 'frontend', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error('frontend/dist is missing - run "npm --prefix frontend run build" first');
}

const edge = new EdgeStack(app, 'SdlcAdvisorEdge', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  domainName,
  hostedZoneName,
  description: 'Secure SDLC Advisor - ACM certificate and CloudFront WAF (us-east-1)',
});

const appStack = new AppStack(app, 'SdlcAdvisorApp', {
  env: { account, region: 'us-west-2' },
  crossRegionReferences: true,
  domainName,
  hostedZoneName,
  certificate: edge.certificate,
  webAclArn: edge.webAclArn,
  modelId,
  historyTtlDays,
  alarmEmail,
  insightsUrl,
  frontendDist: dist,
  description: 'Secure SDLC Advisor - application (us-west-2)',
});
appStack.addDependency(edge);

applyNagSuppressions(edge, appStack);
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
