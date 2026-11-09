# Secure SDLC Advisor

A training-demo web application that helps developers find security, privacy, availability and operational risks
in a **synthetic** application design before deployment. The user describes a fictional application and picks its AWS
components, data classifications and exposure. Amazon Bedrock then generates:

- an architecture summary
- a STRIDE threat model
- security, privacy, availability and operational risks
- recommended AWS controls (mapped to threat IDs)
- a prioritised pre-deployment checklist (P0/P1/P2)
- security user stories with Given/When/Then acceptance criteria
- a downloadable Markdown report

> **Synthetic data only.** The UI shows a prominent notice and requires a confirmation checkbox. Do not enter
> confidential, personal, patient, clinical, regulated, proprietary or production information. This is a vendor-neutral
> demonstration and is not an officially approved tool.

**URL:** https://demo.awsteach.com. Register any username and a password of 6 or more characters. Email and
verification are not needed. Each student can create as many accounts as they like.

## Architecture

```
Browser ──HTTPS──► CloudFront (TLS1.2+, security headers, WAF: rate limit, IP reputation, common & bad-input rules, 16 KB body cap)
                    ├─ /*      ─► S3 (private, OAC)                React SPA + config.json
                    └─ /api/*  ─► API Gateway REST (Cognito authorizer, throttling, access logs)
                                   └─► Lambda "api"  (origin-verify header, validation, redaction, per-user in-flight limit)
                                        ├─► DynamoDB (KMS CMK, TTL 7 days)  — assessment history
                                        └─► Lambda "worker" (async) ─► Bedrock Converse (Claude Sonnet 4.6, us. inference profile)
                                                                         + Bedrock Guardrail (prompt attack, content, PII/secrets)
Cognito user pool (self sign-up, auto-confirm pre-sign-up trigger, 6-char min password)
Observability: structured JSON logs (KMS-encrypted), EMF custom metrics, X-Ray, 6 alarms → SNS, CloudWatch dashboard,
               Route 53 HTTPS health check on /api/health. Audit: multi-region CloudTrail (KMS, log-file validation).
Edge stack (us-east-1): ACM certificate for demo.awsteach.com, CLOUDFRONT-scope WAF web ACL.
App stack (us-west-2): everything else. Route 53 A/AAAA alias records demo.awsteach.com → CloudFront.
```

The request flow is asynchronous because generation takes about 60–90 s, which is longer than API Gateway's 29 s
limit. `POST /api/assessments` validates the input, redacts it, stores it, starts the worker asynchronously and
returns `202`. The browser then polls `GET /api/assessments/{id}`.

### Security controls implemented

| Area | Control |
|---|---|
| Identity | Cognito user pool, ID-token authorizer on all routes except `/api/health`; tokens kept in `sessionStorage`, revoked on sign-out |
| Least privilege | Worker may only `bedrock:InvokeModel` on the one inference profile and its 3 regional model ARNs, plus `ApplyGuardrail` on one guardrail; DynamoDB actions per function are enumerated |
| Edge | WAF (rate limit 3000 per 5 min per IP, Amazon IP reputation, Common and KnownBadInputs rule sets, 16 KB `/api` body cap); API rejects requests without the CloudFront origin-verify secret (Secrets Manager) |
| Transport | HTTPS only, TLS 1.2_2021 policy, HSTS, HTTP/2 and HTTP/3 |
| Headers | Strict CSP (`script-src 'self'`, no inline), `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP and CORP |
| Input | Allow-list schema validation, unknown-field rejection, control and bidi character stripping, length limits, 16 KB body limit, JSON-only content type, optional `.txt`/`.md` import (≤12 KB) checked client-side |
| Sensitive data | Regex redaction (emails, AWS keys, JWTs, bearer tokens, private keys, passwords, connection strings, SSN-, card- and phone-like numbers) **before** storage or model use; Bedrock Guardrail PII anonymisation as a second layer |
| Prompt injection | System prompt treats `<application_description>` as untrusted data; delimiter-spoofing stripped; only user text is sent as `guardContent` to the guardrail's HIGH prompt-attack filter; forced tool-use JSON output |
| Output | Model output is schema-normalised (enums enforced, strings truncated, arrays capped); React renders text only (no `dangerouslySetInnerHTML`); Markdown export escapes Markdown and HTML metacharacters |
| Abuse and cost | API stage throttle 25 rps (POST 5 rps), max 3 in-flight assessments per user, worker reserved concurrency 25, DynamoDB on-demand caps, 10k max output tokens |
| Logging | JSON logs with correlation IDs (`X-Correlation-Id` echoed); **no prompts, descriptions or reports are logged**; API Gateway data trace disabled |
| At rest | One KMS CMK (rotation on) for DynamoDB, CloudWatch Logs, Lambda env vars, SNS, Secrets Manager and CloudTrail; S3 buckets SSE, TLS-only, public access blocked |

## Cost drivers (approximate, us-west-2)

| Driver | Estimate |
|---|---|
| **Bedrock, Claude Sonnet 4.6** | about 2.3k input and 7–8k output tokens per assessment ≈ **$0.11–0.13 each**. 30 students × 10 runs ≈ $35–40 |
| WAF | $5/month web ACL + $1/rule/month (5 rules) + $0.60 per million requests ≈ $10/month prorated |
| KMS CMK | $1/month + requests |
| Route 53 health check | ≈ $0.50–1/month |
| Secrets Manager | $0.40/month |
| CloudFront, API Gateway, Lambda, DynamoDB, S3, CloudWatch | pennies at class scale (pay-per-use) |
| CloudTrail | first copy of management events is free; S3 storage only |

There are no always-on compute or database clusters. Run the teardown after class to stop the small monthly charges.

## Repository layout

```
bin/app.ts                 CDK app (two stacks, cdk-nag AwsSolutions checks)
lib/edge-stack.ts          us-east-1: ACM certificate + WAF
lib/app-stack.ts           us-west-2: everything else
lib/nag-suppressions.ts    reviewed cdk-nag acknowledgments, each with a reason
services/src/              Lambda handlers (api, worker, presignup) and shared libs
services/test/             unit tests (validation, redaction, prompt safety, output normalisation, Markdown)
test/infra.test.ts         CDK assertion tests for security-relevant configuration
frontend/                  React + Vite SPA (tests in src/frontend.test.tsx)
scripts/deploy.sh          pre-flight checks → tests → build → audit → bootstrap → synth (nag) → deploy
scripts/teardown.sh        destroys everything this project created
scripts/smoke-bedrock.ts   one direct Bedrock call using the production prompt and schema
scripts/e2e.sh             post-deploy verification (DNS, TLS, headers, auth, API, full AI assessment)
```

## Deploy / test / tear down

```bash
./scripts/deploy.sh        # idempotent; requires Node 20+, AWS credentials, Bedrock access to the model in cdk.json
./scripts/e2e.sh           # end-to-end verification against https://demo.awsteach.com
./scripts/teardown.sh      # remove all resources (keeps the awsteach.com hosted zone)
```

Configuration is in `cdk.json` context: `domainName`, `hostedZoneName`, `modelId`, `historyTtlDays`, and the optional
`alarmEmail` (`npx cdk deploy -c alarmEmail=you@example.com`). CDK uses its own bootstrap qualifier `sdlcadv` and its
own toolkit stack `SdlcAdvisor-CDKToolkit`, so other CDK apps in the account are not affected.

## Demo-only choices (change these for production)

Cognito uses a 6-character password with no complexity rules, no MFA, no email verification and auto-confirmed self
sign-up. There is no Cognito Plus tier, no DynamoDB PITR and no secret rotation. Each of these is acknowledged with a
reason in `lib/nag-suppressions.ts`.
