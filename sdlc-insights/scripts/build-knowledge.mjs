#!/usr/bin/env node
// Builds projectknowledge.md = narrative + generated sections from the live account; scans for secrets; uploads to S3.
// Usage: node scripts/build-knowledge.mjs [--upload]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const advisorRoot = path.join(root, '..', 'sdlc-advisor');
const aws = (...args) => JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const STACKS = [['SdlcAdvisorEdge', 'us-east-1', 'Secure SDLC Advisor'], ['SdlcAdvisorApp', 'us-west-2', 'Secure SDLC Advisor'], ['SdlcInsightsEdge', 'us-east-1', 'Class Insights'], ['SdlcInsightsApp', 'us-west-2', 'Class Insights']];
const L = [];
const now = new Date().toISOString();

L.push(readFileSync(path.join(root, 'knowledge', 'narrative.md'), 'utf8').trimEnd(), '');

// ---- 11. Prompts (verbatim from source) ----
const extract = (file, name) => {
  const src = readFileSync(file, 'utf8');
  const m = src.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
  return m ? m[1] : '(not found)';
};
L.push('## 11. LLM prompts (verbatim from source code)', '');
L.push('### Advisor system prompt (`sdlc-advisor/services/src/lib/prompt.ts`)', '', '```text', extract(path.join(advisorRoot, 'services/src/lib/prompt.ts'), 'SYSTEM_PROMPT'), '```', '');
L.push('The Advisor user message contains two blocks: a context block (title, exposure, selected component labels, data classifications)',
  'and the user description wrapped in `<application_description>…</application_description>`, sent as Bedrock `guardContent`.',
  'The output tool `submit_assessment` has a JSON schema with: architectureSummary, overallRisk, threats[] (id, stride, component, threat, likelihood, impact, severity, mitigation),',
  'risks[] (category, title, description, severity), controls[] (service, control, rationale, addresses[]), checklist[] (priority P0/P1/P2, item, owner, verification),',
  'userStories[] (title, story, acceptanceCriteria[]), assumptions[]. Inference settings: max 10,000 output tokens, extended thinking budget 2,048 tokens',
  '(temperature 0.2 only on the no-thinking fallback).', '');
L.push('### Chatbot system prompt (`sdlc-insights/services/src/lib/chat-prompt.ts`)', '', '```text', extract(path.join(root, 'services/src/lib/chat-prompt.ts'), 'CHAT_SYSTEM_PROMPT'), '```', '');
L.push('The chatbot system content is: the prompt above + this document inside `<project_knowledge>` + a Bedrock cache point. Settings: max 3,000 output tokens, extended thinking budget 1,024 tokens, up to 5 tool rounds, guardrail on the student question.', '');

// ---- 12. Live inventory ----
L.push(`## 12. Live resource inventory *(generated ${now})*`, '');
const totals = {};
const perStack = [];
for (const [name, region, app] of STACKS) {
  try {
    const res = aws('cloudformation', 'list-stack-resources', '--region', region, '--stack-name', name).StackResourceSummaries;
    const st = aws('cloudformation', 'describe-stacks', '--region', region, '--stack-name', name).Stacks[0];
    perStack.push({ name, region, app, res, st });
    for (const r of res) totals[r.ResourceType] = (totals[r.ResourceType] ?? 0) + 1;
  } catch { perStack.push({ name, region, app, res: [], st: { StackStatus: 'NOT DEPLOYED' } }); }
}
const services = [...new Set(Object.keys(totals).map((t) => t.split('::')[1]))].sort();
L.push(`- **Total CloudFormation resources:** ${Object.values(totals).reduce((a, b) => a + b, 0)}`,
  `- **Distinct resource types:** ${Object.keys(totals).length}`,
  `- **Distinct AWS services (CloudFormation namespaces):** ${services.length}: ${services.join(', ')}`,
  '- Note: CDK also creates helper resources (custom-resource Lambda functions, IAM roles and policies), which are counted here.', '');
L.push('| Stack | Application | Region | Status | Resources | Types |', '|---|---|---|---|---|---|');
for (const s of perStack) L.push(`| ${s.name} | ${s.app} | ${s.region} | ${s.st.StackStatus} | ${s.res.length} | ${new Set(s.res.map((r) => r.ResourceType)).size} |`);
L.push('', '### Resource types (all stacks)', '', '| Type | Count |', '|---|---|');
for (const [t, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) L.push(`| \`${t}\` | ${n} |`);
for (const s of perStack) {
  if (!s.res.length) continue;
  L.push('', `### ${s.name} resources`, '', '| Logical ID | Type |', '|---|---|');
  for (const r of [...s.res].sort((a, b) => a.ResourceType.localeCompare(b.ResourceType))) L.push(`| ${r.LogicalResourceId} | \`${r.ResourceType}\` |`);
  const outs = (s.st.Outputs ?? []).filter((o) => !/secret|password|token|key$/i.test(o.OutputKey) && !/^ExportsOutput/.test(o.OutputKey));
  if (outs.length) { L.push('', `Outputs of ${s.name}:`, ''); for (const o of outs) L.push(`- \`${o.OutputKey}\`: ${o.OutputValue}`); }
}
L.push('');

// ---- 13. Lambda functions (safe fields only; environment variables are deliberately never read) ----
L.push('## 13. Lambda functions *(generated)*', '', '| Function | Runtime | Arch | Memory MB | Timeout s | Reserved concurrency | Purpose |', '|---|---|---|---|---|---|---|');
const purpose = { 'sdlc-advisor-api': 'Advisor REST API', 'sdlc-advisor-worker': 'Advisor Bedrock assessment worker', 'sdlc-advisor-presignup': 'Cognito pre-sign-up auto-confirm', 'sdlc-insights-api': 'Insights pages + chat queue', 'sdlc-insights-chat': 'Insights chatbot worker (Bedrock + tools)' };
for (const fn of Object.keys(purpose)) {
  try {
    const c = aws('lambda', 'get-function-configuration', '--region', 'us-west-2', '--function-name', fn, '--query', '{r:Runtime,a:Architectures,m:MemorySize,t:Timeout}');
    let rc = '—';
    try { rc = aws('lambda', 'get-function-concurrency', '--region', 'us-west-2', '--function-name', fn).ReservedConcurrentExecutions ?? '—'; } catch { /* none */ }
    L.push(`| ${fn} | ${c.r} | ${c.a.join(',')} | ${c.m} | ${c.t} | ${rc} | ${purpose[fn]} |`);
  } catch { L.push(`| ${fn} | not deployed | | | | | ${purpose[fn]} |`); }
}
L.push('', 'CDK also deploys helper functions (BucketDeployment, S3 auto-delete, cross-region export reader/writer, log retention) that are not application code.', '');

// ---- 14. Test results ----
L.push('## 14. Test results', '');
for (const [label, file] of [['Secure SDLC Advisor end-to-end (scripts/e2e.sh)', path.join(advisorRoot, 'e2e-results.txt')], ['Class Insights end-to-end (scripts/e2e.sh)', path.join(root, 'e2e-results.txt')]]) {
  if (existsSync(file)) L.push(`### ${label}`, '', '```text', readFileSync(file, 'utf8').trim(), '```', '');
}
L.push('Unit and infrastructure tests: the Advisor has 24 backend/CDK tests and 6 frontend tests; Insights has 15 backend/CDK tests and 5 frontend tests. All run on every deploy.', '');
L.push(`---`, `*Document generated ${now} by \`sdlc-insights/scripts/build-knowledge.mjs\`.*`, '');

let md = L.join('\n');

// ---- Secret scan ----
const problems = [];
for (const id of ['sdlc-advisor/origin-verify', 'sdlc-insights/origin-verify']) {
  try {
    const v = execFileSync('aws', ['secretsmanager', 'get-secret-value', '--region', 'us-west-2', '--secret-id', id, '--query', 'SecretString', '--output', 'text'], { encoding: 'utf8' }).trim();
    if (v && md.includes(v)) problems.push(`contains the value of ${id}`);
  } catch { /* secret not deployed yet */ }
}
const patterns = { awsKeyId: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, privateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, jwt: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, secretAssign: /(aws_secret_access_key|password)\s*[:=]\s*\S{6,}/i, email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ };
for (const [n, re] of Object.entries(patterns)) if (re.test(md)) problems.push(`matches ${n} pattern: ${md.match(re)[0].slice(0, 12)}…`);
if (problems.length) { console.error('SECRET SCAN FAILED:\n - ' + problems.join('\n - ')); process.exit(1); }

const out = path.join(root, 'knowledge', 'projectknowledge.md');
writeFileSync(out, md);
console.log(`Wrote ${out} (${md.length} chars, ~${Math.round(md.length / 4)} tokens). Secret scan passed.`);

if (process.argv.includes('--upload')) {
  const bucket = aws('cloudformation', 'describe-stacks', '--region', 'us-west-2', '--stack-name', 'SdlcInsightsApp').Stacks[0].Outputs.find((o) => o.OutputKey === 'KnowledgeBucket').OutputValue;
  execFileSync('aws', ['s3', 'cp', out, `s3://${bucket}/projectknowledge.md`, '--content-type', 'text/markdown; charset=utf-8', '--region', 'us-west-2'], { stdio: 'inherit' });
  console.log(`Uploaded to s3://${bucket}/projectknowledge.md`);
}
