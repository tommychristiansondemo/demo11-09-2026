#!/usr/bin/env bash
# Build, test, validate and deploy Secure SDLC Advisor. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION=us-west-2
TOOLKIT=SdlcAdvisor-CDKToolkit
QUALIFIER=sdlcadv

echo "== Pre-flight"
aws route53 list-hosted-zones-by-name --dns-name awsteach.com --query "HostedZones[?Name=='awsteach.com.'].Id" --output text | grep -q hostedzone \
  || { echo "Hosted zone awsteach.com not found"; exit 1; }
MODEL=$(node -e "console.log(require('./cdk.json').context.modelId)")
aws bedrock-runtime converse --region us-west-2 --model-id "$MODEL" --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
  --inference-config maxTokens=5 --query stopReason --output text >/dev/null || { echo "Model $MODEL is not invocable"; exit 1; }

echo "== Install, test, build"
npm ci --no-audit --no-fund
npm --prefix frontend ci --no-audit --no-fund
npx tsc --noEmit -p .
npx vitest run
npm --prefix frontend run build
npm --prefix frontend test
npm audit --omit=dev
npm --prefix frontend audit --omit=dev

echo "== Bootstrap (separate toolkit stack + qualifier so other CDK apps are untouched)"
for r in us-east-1 us-west-2; do
  npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$r" --toolkit-stack-name $TOOLKIT --qualifier $QUALIFIER \
    --tags project=secure-sdlc-advisor >/dev/null
done

echo "== Synth (cdk-nag AwsSolutions checks fail the build on unacknowledged findings)"
npx cdk synth --quiet

echo "== Deploy"
npx cdk deploy --all --toolkit-stack-name $TOOLKIT --require-approval never --outputs-file cdk-outputs.json
echo "Deployed: https://$(node -e "console.log(require('./cdk.json').context.domainName)")"
