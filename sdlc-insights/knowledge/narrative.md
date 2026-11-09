# Project knowledge: Secure SDLC Advisor and Class Insights

This document is the authoritative description of everything deployed for this AWS class. The Class Insights chatbot
reads it to answer student questions. It is regenerated and re-uploaded to S3 whenever the deployment changes. Sections
marked *(generated)* are produced automatically from the live AWS account at upload time.

> Training demonstration with synthetic data only. Neither application is an official or approved tool of any company.
> No API keys, passwords, tokens or secret values appear in this document or are reachable by the chatbot.

## 1. The two applications at a glance

| | Secure SDLC Advisor | Class Insights |
|---|---|---|
| URL | https://demo.awsteach.com | https://sdlc-insights.awsteach.com |
| Purpose | A developer describes a *synthetic* application and gets an AI-generated pre-deployment security assessment | Explains to students how the Advisor (and this app) were designed, deployed and operated; chatbot + live AWS data |
| Users | Students self-register in Amazon Cognito (any username, password of 6 or more characters, no email verification). One user type: developer | Same Cognito user pool as the Advisor (same accounts). Its own Cognito app client |
| LLM | Anthropic Claude Sonnet 4.6 on Amazon Bedrock (`us.anthropic.claude-sonnet-4-6`, US cross-region inference profile) | Same model, Claude Sonnet 4.6, with tool use, extended thinking and prompt caching |
| Source code | `/home/tommy/demo/sdlc-advisor` on the instructor's machine | `/home/tommy/demo/sdlc-insights` |
| Infrastructure as code | AWS CDK v2 (TypeScript), stacks `SdlcAdvisorEdge` (us-east-1) and `SdlcAdvisorApp` (us-west-2) | AWS CDK v2 (TypeScript), stacks `SdlcInsightsEdge` (us-east-1) and `SdlcInsightsApp` (us-west-2) |
| CDK bootstrap | Qualifier `sdlcadv`, toolkit stack `SdlcAdvisor-CDKToolkit` | Qualifier `sdlcins`, toolkit stack `SdlcInsights-CDKToolkit` |

Both applications were designed, coded, tested and deployed by an AI coding agent (Claude Code) from a written
specification supplied by the instructor. No console clicks were part of the solution.

## 2. Secure SDLC Advisor: what it does

1. The user signs in, then enters an application title and a description of a **fictional** system. The description can
   also be imported from a `.txt` or `.md` file (12 KB or less, checked in the browser). Five built-in synthetic examples are
   provided: Lab Equipment Booking Portal, Public Study FAQ Assistant (GenAI), Supplier Invoice Processing Pipeline,
   Manufacturing Sensor Telemetry Dashboard, and Employee Onboarding Agent (GenAI).
2. The user selects architecture components (34 options in 9 groups, e.g. CloudFront, Lambda, DynamoDB, Bedrock),
   data classifications (7 options, e.g. public, synthetic PII) and exposure (internet, partner, internal, batch).
3. The user must tick a confirmation that the submission contains only synthetic or nonconfidential information.
   A prominent banner warns not to enter Gilead confidential, personal, patient, clinical, regulated, proprietary or
   production information.
4. Amazon Bedrock generates: an architecture summary, a STRIDE threat model (8–12 threats), security, privacy,
   availability and operational risks, recommended AWS controls mapped to threat IDs, a prioritised pre-deployment
   checklist (P0/P1/P2), 4–6 security user stories with Given/When/Then acceptance criteria, and assumptions.
5. The result is shown in tabs and can be downloaded as a Markdown report. History is kept per user for 7 days and then
   deleted automatically by DynamoDB TTL.

### Where the Advisor gets its data
- **User input only.** The sole input is what the student types or picks (or a built-in synthetic example). The Advisor
  does not read any external database, document store, internet source or company system.
- **Built-in catalogs** (component list, data classifications, exposure options) are static code in
  `services/src/lib/catalog.ts`, shared by the frontend and the API.
- **The model's own training knowledge** (Claude Sonnet 4.6) supplies the security expertise. There is no RAG or
  knowledge base in the Advisor.
- Stored data: the redacted input plus the generated result, in DynamoDB table `sdlc-advisor-assessments`
  (partition key `userId` = Cognito `sub`, sort key `assessmentId`), encrypted with a customer-managed KMS key.

### Request flow (asynchronous)
Generation takes about 60–100 seconds, which is longer than API Gateway's 29-second integration limit, so the flow is asynchronous:
1. Browser → CloudFront (`/api/*`) → API Gateway REST API (Cognito authorizer) → Lambda `sdlc-advisor-api`.
2. The API Lambda checks the CloudFront origin-verify header, validates the JSON against a strict allow-list, redacts
   sensitive-looking strings, enforces at most 3 in-flight assessments per user, writes a `PENDING` item to DynamoDB,
   invokes Lambda `sdlc-advisor-worker` asynchronously, and returns HTTP 202 with the assessment id.
3. The worker calls Bedrock `Converse` with the system prompt, the context, and the user description wrapped in
   `<application_description>` tags and sent as `guardContent` to the Bedrock Guardrail. The model must answer by calling
   the tool `submit_assessment`, whose JSON schema defines every section. Extended thinking (2,048-token budget) is on.
   If the model doesn't call the tool, a second attempt forces the tool with thinking off.
4. The worker normalises the output (enums enforced, strings truncated, arrays capped) and stores it as `COMPLETE`, or
   `BLOCKED` (guardrail) or `FAILED`.
5. The browser polls `GET /api/assessments/{id}` every 3 seconds. The Markdown report is built server-side with Markdown
   and HTML escaping.

### Advisor API routes
| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Health check (used by a Route 53 HTTPS health check) |
| `POST /api/assessments` | Cognito | Validate, redact, queue an assessment (202) |
| `GET /api/assessments` | Cognito | List the caller's assessments (newest first) |
| `GET /api/assessments/{id}` | Cognito | Status, result and Markdown report |
| `DELETE /api/assessments/{id}` | Cognito | Delete one assessment |

## 3. Class Insights: what it does
- **Chatbot.** Claude Sonnet 4.6 reads this document (`projectknowledge.md`, loaded from S3 and cached for 60 seconds)
  and can call six read-only tools that fetch live data:
  `get_resource_inventory` (CloudFormation ListStackResources across the 4 stacks), `get_deployment_events`
  (CloudFormation stack events), `query_logs` (CloudWatch Logs FilterLogEvents on allow-listed log groups),
  `get_llm_reasoning_logs` (the structured LLM reasoning records), `get_metrics` (CloudWatch GetMetricData on
  allow-listed metrics) and `get_alarms` (CloudWatch DescribeAlarms). Up to 5 tool rounds per question. The answer, the
  raw data it fetched and the model's reasoning are all shown to the student.
- **Pages.** Project knowledge (this document, rendered), live resource inventory, logs explorer, LLM reasoning logs,
  and metrics and alarms. Each page is served by Lambda; nothing is precomputed.
- **Static frontend** (React + Vite) in a private S3 bucket behind CloudFront. **All dynamic content** comes from two Lambda
  functions: `sdlc-insights-api` (synchronous pages and chat queueing) and `sdlc-insights-chat` (the asynchronous chatbot
  worker). Chat jobs are stored in DynamoDB table `sdlc-insights-chat` with a 1-day TTL.
- **Knowledge storage.** `projectknowledge.md` lives in S3 bucket `sdlc-insights-knowledge-<account-id>`: versioned
  (every update is retained for 60 days), encrypted with the Class Insights KMS key, public access blocked, TLS required.

### Insights API routes
| Route | Purpose |
|---|---|
| `GET /api/health` | Health check (no auth) |
| `GET /api/knowledge` | The current projectknowledge.md |
| `GET /api/inventory` | Live CloudFormation inventory of the 4 stacks |
| `GET /api/events?stack=` | Recent deployment events of one stack |
| `GET /api/logs?source=&minutes=&filter=` | Sanitised CloudWatch log events |
| `GET /api/reasoning?app=&hours=` | LLM reasoning-log records |
| `GET /api/metrics?hours=` | Metric totals and alarm states |
| `GET /api/sources` | Allow-listed log sources and stacks |
| `POST /api/chat`, `GET /api/chat/{id}` | Ask a question (202), then poll for the answer |

### Why no secrets can leak through Class Insights
- The Insights Lambda roles have **no** `secretsmanager:*`, `ssm:GetParameter*`, `lambda:GetFunction*` (which would
  reveal environment variables) or `cloudformation:GetTemplate` permission. Unit tests in `test/infra.test.ts` assert this.
- Log reads are limited to the `/sdlc-advisor/*` and `/sdlc-insights/*` log groups. Neither application ever logs secrets,
  prompts, descriptions or reports.
- Every tool result and log line is sanitised again: AWS key IDs, secret-key assignments, JWTs, bearer tokens, private
  keys, passwords, connection-string passwords, emails, phone, SSN-like and card-like numbers are redacted. IPv4 and IPv6
  addresses are masked (e.g. `203.0.x.x`). Any `x-origin-verify` value and any JSON key named like a secret, password or
  token is replaced with `[REDACTED]`.
- `projectknowledge.md` is scanned before every upload. The upload fails if it contains either application's actual
  origin-verify secret value or anything matching the secret patterns.
- The chatbot system prompt forbids revealing secret values. A Bedrock Guardrail (prompt-attack filter HIGH on the
  student's question, plus PII and credential anonymisation) sits in front of the model.

## 4. LLM reasoning logging
Every LLM call in both applications writes one structured JSON record with `"type": "llm_reasoning"` to the calling
function's CloudWatch log group: `/sdlc-advisor/worker` for the Advisor and `/sdlc-insights/chat` for the chatbot.
Fields: `ts, app, correlationId, subjectId` (assessment or chat id), `modelId, promptVersion` (first 12 hex characters of
SHA-256 of the system prompt), `attempt, thinkingEnabled, stopReason, guardrailAction, inputTokens, outputTokens, latencyMs,
toolCalls`, `reasoning` (Claude's extended-thinking text, redacted, capped at 6,000 characters), `reasoningChars`, and `note`.

**Design choice:** the original specification said "Do not log complete prompts or generated reports". The reasoning log
therefore records the model's *reasoning* and the invocation metadata, but never the full prompt or the generated report.
The system prompts are not secret and are published verbatim in section 11 of this document, so students can see
exactly what the model was told. Class Insights finds the records with the CloudWatch filter term
`"llm_reasoning"` and parses the JSON after Lambda's text-format line prefix (timestamp, request id, level).

## 5. Security controls (both applications)
| Area | Control |
|---|---|
| Edge | CloudFront with TLS 1.2 (`TLSv1.2_2021`), HTTP→HTTPS redirect, HTTP/2 and HTTP/3. AWS WAF web ACL per app (CLOUDFRONT scope, us-east-1): rate limit of 3,000 requests per 5 minutes per IP, Amazon IP reputation list, Core rule set (8 KB body rule and XSS-body rule set to *count* because users legitimately describe attacks in prose), Known bad inputs, and a custom rule blocking `/api/` bodies over 16 KB |
| Origin protection | S3 origins use Origin Access Control (buckets are private). API origins receive a secret `x-origin-verify` header from CloudFront, generated in AWS Secrets Manager. The API Lambda rejects requests without it (HTTP 403), so WAF can't be bypassed via the execute-api URL |
| Security headers | Strict Content-Security-Policy (`script-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'`, `connect-src` limited to self and the Cognito endpoint), HSTS (1 year), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy, Cross-Origin-Opener-Policy |
| Authentication | Amazon Cognito user pool `sdlc-advisor-users`: self sign-up, auto-confirmed by a pre-sign-up Lambda, 6-character minimum password with no complexity rules, no MFA, no email verification (deliberately demo-grade). ID token (1 hour) checked by the API Gateway Cognito authorizer. Refresh token 1 day, revoked on sign-out |
| Authorisation | Every data item is keyed by the caller's Cognito `sub`, so one student can't read another's assessments (verified by an end-to-end test) |
| Least-privilege IAM | Each Lambda has its own role with enumerated actions. The Advisor worker can call only `bedrock:InvokeModel` on the one inference profile and its 3 regional model ARNs, plus `bedrock:ApplyGuardrail` on one guardrail |
| Input validation | Allow-list schema, unknown fields rejected, control and bidi characters stripped, length limits (title 3–120 characters, description 40–6,000 characters), JSON content type required, 16 KB body limit at both WAF and Lambda |
| Redaction | Likely emails, AWS keys, JWTs, bearer tokens, private keys, passwords, connection-string passwords, SSN-, card- and phone-like numbers are redacted **before** storage or model use. The Bedrock Guardrail anonymises PII as a second layer |
| Prompt injection | User text is delimited and declared untrusted in the system prompt. Delimiter spoofing is stripped. Only user text goes to the guardrail as `guardContent` (prompt-attack filter HIGH). Output is a forced JSON tool schema. A blatant jailbreak was tested and **BLOCKED** by the guardrail. A mild "ignore previous instructions" inside a normal description was ignored by the model and noted in assumptions |
| Output encoding | React renders text only (no `dangerouslySetInnerHTML`). The Insights Markdown renderer skips raw HTML. The Advisor's Markdown export escapes Markdown and HTML metacharacters |
| Encryption at rest | Each app has a customer-managed KMS key (rotation on) for DynamoDB, CloudWatch Logs, Lambda environment variables, SNS, Secrets Manager, the CloudTrail bucket and the knowledge bucket |
| Throttling and cost guards | Advisor stage: 25 rps (POST 5 rps), at most 3 in-flight assessments per user, worker reserved concurrency 25, 10k max output tokens. Insights stage: 20 rps (chat POST 3 rps), chat reserved concurrency 20, 3k max output tokens |
| Logging | Structured JSON logs with correlation IDs (`X-Correlation-Id` accepted from the client and echoed). API Gateway data tracing disabled. No prompts, descriptions or reports in logs. Log groups encrypted, 14-day retention |
| Audit | Multi-region AWS CloudTrail trail `sdlc-advisor-trail` (management events, log-file validation, KMS-encrypted S3 bucket with a 90-day lifecycle) |
| Validation tooling | cdk-nag AwsSolutions rule pack runs on every synth; each accepted finding is acknowledged with a written reason. npm audit (0 vulnerabilities). Vitest unit tests and CDK assertion tests |

## 6. Observability
- Advisor dashboard `sdlc-advisor-operations`, Insights dashboard `sdlc-insights-operations`.
- Advisor alarms (to SNS topic `sdlc-advisor-alarms`): API 5xx, API p90 latency, API Lambda errors, worker errors, worker
  throttles, assessment failures. Insights alarms: chat failures, chat Lambda errors, API Lambda errors, API 5xx.
- Custom metrics via CloudWatch Embedded Metric Format. Namespace `SecureSdlcAdvisor`: AssessmentsRequested,
  AssessmentsCompleted, AssessmentsFailed, GuardrailBlocks, Redactions, InputTokens, OutputTokens, BedrockLatencyMs,
  AssessmentDurationMs. Namespace `SdlcClassInsights`: ChatQuestions, ChatFailures, ChatGuardrailBlocks, ChatDurationMs,
  InputTokens, OutputTokens, CacheReadTokens, ToolCalls.
- AWS X-Ray tracing is on for all Lambdas and API stages. A Route 53 HTTPS health check runs on `https://demo.awsteach.com/api/health`.
- Log groups (all KMS-encrypted, 14-day retention): `/sdlc-advisor/api`, `/sdlc-advisor/worker`, `/sdlc-advisor/presignup`,
  `/sdlc-advisor/apiaccess`, `/sdlc-insights/api`, `/sdlc-insights/chat`, `/sdlc-insights/apiaccess`. In the chatbot and
  logs page these are the sources `advisor-api`, `advisor-worker`, `advisor-presignup`, `advisor-api-access`,
  `insights-api`, `insights-chat`, `insights-api-access`.

## 7. Model selection
Before deployment the agent listed the Bedrock inference profiles in us-west-2 and test-invoked candidates. Claude
Sonnet 5.5 and Haiku 5.5 appear in the catalog but returned AccessDenied for this account. Claude Sonnet 4.6 and Haiku 4.5
were invocable. Sonnet 4.6 was chosen for assessment quality. A direct test produced 12 threats, 15 checklist items and
5 user stories in about 72 seconds (about 2.3k input and 7.2k output tokens). It goes through the **US cross-region
inference profile**, which may route to us-east-1, us-east-2 or us-west-2. The chatbot uses the same model, with
**prompt caching**: the system prompt and this document are a cache point, so repeat questions read them from cache.

## 8. Cost drivers (approximate)
| Driver | Estimate |
|---|---|
| Bedrock, Advisor | about 2.3k input and 7.5–9k output tokens (including thinking) per assessment, at $3 per million input and $15 per million output, ≈ **$0.12–0.15 per assessment** |
| Bedrock, chatbot | about 15–25k input tokens (mostly cached after the first question) plus 0.5–2k output tokens per round, ≈ **$0.02–0.08 per question** depending on tool rounds |
| AWS WAF | 2 web ACLs × ($5 per month + $1 per rule per month × 5 rules) + $0.60 per million requests ≈ $20 per month prorated |
| KMS | 2 customer-managed keys × $1 per month |
| Secrets Manager | 2 secrets × $0.40 per month |
| Route 53 | Health check ≈ $0.50–1 per month. Hosted zone already existed |
| Pay-per-use services | CloudFront, API Gateway, Lambda, DynamoDB on-demand, S3, CloudWatch, X-Ray: pennies at class scale |
| CloudTrail | First copy of management events is free; S3 storage only |
There are no always-on servers, containers or database clusters. Teardown scripts stop all charges.

## 9. Deployment process
Both apps use `scripts/deploy.sh`, which runs:
1. **Pre-flight.** Confirm the `awsteach.com` hosted zone exists, the chosen model is invocable, and no DNS collision.
2. `npm ci`, TypeScript type-check, unit and CDK assertion tests (Vitest), production frontend build, frontend tests, `npm audit`.
3. `cdk bootstrap` in us-east-1 and us-west-2 with a project-specific qualifier, so other CDK apps in the account are untouched.
4. `cdk synth` with cdk-nag. Unacknowledged findings fail the build.
5. `cdk deploy --all`. The edge stack (ACM certificate validated by DNS in Route 53, plus WAF) goes first, then the app stack
   (cross-region references pass the certificate and WAF ARNs through SSM parameters managed by CDK).
6. For Insights only: regenerate `projectknowledge.md` (narrative + live inventory + function settings + prompts +
   test results), scan it for secrets, and upload it to the knowledge bucket.
7. `scripts/e2e.sh`: end-to-end verification on the live site.

DNS: `demo.awsteach.com` and `sdlc-insights.awsteach.com` are Route 53 A and AAAA alias records pointing to their CloudFront
distributions. The instructor said `www.awsteach.com` and `insights.awsteach.com` belong to another application, so
they were not touched, and the Insights app uses `sdlc-insights` to avoid any collision.

## 10. Deployment history and lessons learned
- **2026-11-09, Advisor v1.0.** Edge stack deployed first try. The first app-stack deploy **failed** at
  `AWS::CloudTrail::Trail` with "Insufficient permissions to access S3 bucket … or KMS key". Root cause: CDK adds the
  CloudTrail bucket policy only when it creates the trail bucket itself. This design passed its own KMS-encrypted
  bucket. Fix: explicit bucket-policy statements (`s3:GetBucketAcl`, `s3:PutObject` on `AWSLogs/<account>/*` with
  `bucket-owner-full-control`, both conditioned on the trail's `aws:SourceArn`), a KMS key-policy statement for CloudTrail,
  and a dependency so the policy exists before the trail. The rolled-back stack (`ROLLBACK_COMPLETE`) was deleted and
  redeployed successfully.
- **2026-11-09.** A local Bedrock smoke test found that `guardContent` blocks are rejected when no guardrail is configured
  ("The guardrail configuration is missing"). The worker now uses plain text when no guardrail is set.
- **2026-11-09.** End-to-end verification: 43 of 43 checks passed after fixing one test-script bug (`curl -I` sends HEAD, which
  the API does not route).
- **2026-11-09, Advisor v1.1 and Class Insights v1.0.** Extended thinking and LLM reasoning logs added to the Advisor
  worker. Testing found that "Thinking may not be enabled when tool_choice forces tool use", so the worker now uses
  `tool_choice: auto` with thinking and falls back to a forced tool call without thinking. Class Insights deployed, and a
  "Class Insights" link added to the Advisor header and sign-in page.
- **2026-11-09, Class Insights v1.0.1.** Insights end-to-end testing found two bugs. (1) `cloudwatch:DescribeAlarms` with an
  alarm-name prefix is authorised against `alarm:*`, so the prefix-scoped IAM resource caused AccessDenied. The permission
  is now `alarm:*` (read-only). (2) The reasoning-log query used a JSON filter pattern, which never matches because Lambda's
  text log format prefixes each line. It now uses a term filter and parses the JSON after the prefix. Custom EMF metrics
  were unaffected.
