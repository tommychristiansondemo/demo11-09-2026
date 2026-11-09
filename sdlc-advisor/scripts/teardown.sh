#!/usr/bin/env bash
# Remove every Secure SDLC Advisor resource. Leaves the awsteach.com hosted zone and all unrelated stacks alone.
set -euo pipefail
cd "$(dirname "$0")/.."
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TOOLKIT=SdlcAdvisor-CDKToolkit
DOMAIN=$(node -e "console.log(require('./cdk.json').context.domainName)")

npx cdk destroy --all --force --toolkit-stack-name $TOOLKIT || true

# CDK leaves the ACM DNS-validation CNAME in Route 53; remove only the one for our domain.
ZONE=$(aws route53 list-hosted-zones-by-name --dns-name awsteach.com --query "HostedZones[?Name=='awsteach.com.'].Id" --output text | sed 's#/hostedzone/##')
aws route53 list-resource-record-sets --hosted-zone-id "$ZONE" --output json \
  --query "ResourceRecordSets[?Type=='CNAME' && ends_with(Name, '.${DOMAIN}.')]" > /tmp/sdlc-cname.json
if [ "$(node -e "console.log(require('/tmp/sdlc-cname.json').length)")" != "0" ]; then
  node -e "const r=require('/tmp/sdlc-cname.json');console.log(JSON.stringify({Changes:r.map(x=>({Action:'DELETE',ResourceRecordSet:x}))}))" > /tmp/sdlc-change.json
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch file:///tmp/sdlc-change.json >/dev/null && echo "Removed ACM validation CNAME"
fi

# API Gateway account setting points at the deleted CloudWatch role; reset it (us-west-2 only).
aws apigateway update-account --region us-west-2 --patch-operations op=replace,path=/cloudwatchRoleArn,value='' >/dev/null 2>&1 || true

# Remove the bootstrap stacks and their retained buckets (only ours: qualifier sdlcadv).
for r in us-east-1 us-west-2; do
  B=$(aws cloudformation describe-stacks --region $r --stack-name $TOOLKIT --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text 2>/dev/null || true)
  if [ -n "$B" ] && [ "$B" != "None" ]; then
    python3 - "$B" "$r" <<'PY'
import boto3, sys
b = boto3.resource('s3', region_name=sys.argv[2]).Bucket(sys.argv[1])
b.object_versions.delete(); b.delete()
PY
  fi
  aws cloudformation delete-stack --region $r --stack-name $TOOLKIT 2>/dev/null || true
  aws ecr delete-repository --region $r --repository-name "cdk-sdlcadv-container-assets-$CDK_DEFAULT_ACCOUNT-$r" --force >/dev/null 2>&1 || true
done
# Lambda/CDK log groups that outlive the stacks
for g in $(aws logs describe-log-groups --region us-west-2 --log-group-name-prefix /aws/lambda/SdlcAdvisor --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --region us-west-2 --log-group-name "$g"
done
echo "Teardown complete."
