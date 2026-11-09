#!/usr/bin/env bash
# Post-deployment verification for Secure SDLC Advisor.
set -uo pipefail
cd "$(dirname "$0")/.."
DOMAIN=$(node -e "console.log(require('./cdk.json').context.domainName)")
BASE="https://$DOMAIN"
OUT=cdk-outputs.json
j() { node -e "const o=require('./$OUT').SdlcAdvisorApp; console.log(o['$1'])"; }
POOL_CLIENT=$(j UserPoolClientId); API_ID=$(j ApiId)
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }
jq_() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s||'{}');const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)})"; }

echo "== DNS / TLS"
check "DNS A record resolves" '[ -n "$(dig +short A $DOMAIN)" ]'
check "DNS AAAA record resolves" '[ -n "$(dig +short AAAA $DOMAIN)" ]'
check "Certificate valid for $DOMAIN" 'curl -sS -o /dev/null --fail "$BASE/"'
check "HTTP redirects to HTTPS" '[ "$(curl -s -o /dev/null -w "%{http_code}" "http://$DOMAIN/")" = "301" ]'
check "TLS 1.1 refused" '! curl -s -o /dev/null --tls-max 1.1 "$BASE/" 2>/dev/null'

echo "== Security headers"
H=$(curl -sSI "$BASE/")
for h in strict-transport-security content-security-policy x-frame-options x-content-type-options referrer-policy permissions-policy; do
  check "header $h" 'grep -qi "^$h:" <<<"$H"'
done
check "CSP forbids framing" 'grep -i "^content-security-policy:" <<<"$H" | grep -q "frame-ancestors .none."'
check "config.json served" 'curl -sf "$BASE/config.json" | grep -q userPoolId'

echo "== API basics"
check "GET /api/health = 200" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health")" = "200" ]'
check "health has security headers" 'curl -s -D - -o /dev/null "$BASE/api/health" | grep -qi "^strict-transport-security:"'
check "unauthenticated list = 401" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/assessments")" = "401" ]'
check "direct execute-api bypass = 403" '[ "$(curl -s -o /dev/null -w "%{http_code}" "https://$API_ID.execute-api.us-west-2.amazonaws.com/prod/api/health")" = "403" ]'
check "correlation id echoed" 'curl -s -D - -o /dev/null -H "X-Correlation-Id: e2e-test-12345" "$BASE/api/health" | grep -qi "x-correlation-id: e2e-test-12345"'

echo "== Authentication (self sign-up, no verification)"
U1="e2e-a-$(date +%s)"; U2="e2e-b-$(date +%s)"; PW="abc123"
signup() { aws cognito-idp sign-up --region us-west-2 --client-id "$POOL_CLIENT" --username "$1" --password "$PW" --query UserConfirmed --output text; }
token()  { aws cognito-idp initiate-auth --region us-west-2 --client-id "$POOL_CLIENT" --auth-flow USER_PASSWORD_AUTH --auth-parameters USERNAME="$1",PASSWORD="$PW" --query AuthenticationResult.IdToken --output text; }
check "sign-up auto-confirms user 1 (6-char password)" '[ "$(signup $U1)" = "True" ]'
check "sign-up auto-confirms user 2" '[ "$(signup $U2)" = "True" ]'
check "short password rejected" '! aws cognito-idp sign-up --region us-west-2 --client-id "$POOL_CLIENT" --username "e2e-c-$(date +%s)" --password abc >/dev/null 2>&1'
T1=$(token $U1); T2=$(token $U2)
check "sign-in returns tokens" '[ ${#T1} -gt 100 ] && [ ${#T2} -gt 100 ]'
api() { curl -s -w "\n%{http_code}" -H "Authorization: $1" -H "Content-Type: application/json" -X "$2" "$BASE/api$3" ${4:+--data "$4"}; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
check "authenticated list = 200" '[ "$(code "$(api $T1 GET /assessments)")" = "200" ]'

echo "== Validation"
GOOD='{"title":"E2E Lab Booking","description":"Fictional internal portal for booking shared lab instruments. React SPA on S3 + CloudFront, API Gateway and Lambda, DynamoDB, Cognito federated with corporate SSO. Contact test.user@example.com for questions.","components":["cloudfront","apigw","lambda","dynamodb","cognito"],"dataClassifications":["internal"],"exposure":"internal","syntheticConfirmed":true}'
R=$(api $T1 POST /assessments "${GOOD/\"syntheticConfirmed\":true/\"syntheticConfirmed\":false}")
check "missing synthetic confirmation = 400" '[ "$(code "$R")" = "400" ]'
R=$(api $T1 POST /assessments "${GOOD/\"lambda\"/\"mainframe\"}")
check "unsupported component = 400" '[ "$(code "$R")" = "400" ]'
R=$(api $T1 POST /assessments '{bad json')
check "invalid JSON = 400" '[ "$(code "$R")" = "400" ]'
BIG=$(node -e "console.log(JSON.stringify({title:'x'.repeat(10),description:'y'.repeat(20000),components:['lambda'],dataClassifications:['public'],exposure:'internal',syntheticConfirmed:true}))")
R=$(api $T1 POST /assessments "$BIG")
check "oversize body blocked (WAF 403 or API 413)" '[[ "$(code "$R")" =~ ^(403|413)$ ]]'
check "invalid id = 400" '[ "$(code "$(api $T1 GET /assessments/notanid)")" = "400" ]'

echo "== End-to-end AI assessment"
R=$(api $T1 POST /assessments "$GOOD")
check "create = 202" '[ "$(code "$R")" = "202" ]'
ID=$(body "$R" | jq_ 'o.assessmentId'); RED=$(body "$R" | jq_ 'o.redactions')
check "email redacted before processing (redactions=$RED)" '[ "$RED" -ge 1 ]'
START=$(date +%s); STATUS=PENDING
while [ "$STATUS" = "PENDING" ] && [ $(( $(date +%s) - START )) -lt 300 ]; do
  sleep 5; D=$(body "$(api $T1 GET /assessments/$ID)"); STATUS=$(jq_ 'o.status' <<<"$D")
done
echo "  ... finished with status $STATUS after $(( $(date +%s) - START ))s"
check "assessment COMPLETE" '[ "$STATUS" = "COMPLETE" ]'
check "stored input has no raw email" '! grep -q "test.user@example.com" <<<"$D"'
check "threat model has STRIDE entries" '[ "$(jq_ "o.result.threats.length" <<<"$D")" -ge 6 ]'
check "checklist has P0 items" '[ "$(jq_ "o.result.checklist.filter(c=>c.priority===\"P0\").length" <<<"$D")" -ge 1 ]'
check "user stories with acceptance criteria" '[ "$(jq_ "o.result.userStories.filter(u=>u.acceptanceCriteria.length>0).length" <<<"$D")" -ge 3 ]'
check "markdown report generated" 'jq_ "o.markdown" <<<"$D" | grep -q "## 2. STRIDE threat model"'
jq_ 'o.markdown' <<<"$D" > e2e-sample-report.md
check "user 2 cannot read user 1's assessment" '[ "$(code "$(api $T2 GET /assessments/$ID)")" = "404" ]'
check "listed in user 1 history" 'body "$(api $T1 GET /assessments)" | grep -q "$ID"'
check "not in user 2 history" '! body "$(api $T2 GET /assessments)" | grep -q "$ID"'
check "delete = 200" '[ "$(code "$(api $T1 DELETE /assessments/$ID)")" = "200" ]'
check "deleted item = 404" '[ "$(code "$(api $T1 GET /assessments/$ID)")" = "404" ]'

echo "== Logging hygiene"
sleep 5
LOGS=$(aws logs filter-log-events --region us-west-2 --log-group-name /sdlc-advisor/api --start-time $(( (START-400)*1000 )) --query 'events[].message' --output text 2>/dev/null; aws logs filter-log-events --region us-west-2 --log-group-name /sdlc-advisor/worker --start-time $(( (START-400)*1000 )) --query 'events[].message' --output text 2>/dev/null)
check "logs contain correlation IDs" 'grep -q correlationId <<<"$LOGS"'
check "logs do not contain the description" '! grep -q "booking shared lab instruments" <<<"$LOGS"'

# Clean up the test users
for u in $U1 $U2; do aws cognito-idp admin-delete-user --region us-west-2 --user-pool-id "$(j UserPoolId)" --username "$u" 2>/dev/null; done
echo; echo "RESULT: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
