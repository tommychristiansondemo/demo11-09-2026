// Shared catalog used by both the API (validation) and the frontend (form options).
// Keep this file dependency-free so it can be imported from either side.

export const COMPONENTS = [
  { id: 'cloudfront', label: 'Amazon CloudFront', group: 'Edge & Web' },
  { id: 'waf', label: 'AWS WAF', group: 'Edge & Web' },
  { id: 's3-static', label: 'Amazon S3 (static website)', group: 'Edge & Web' },
  { id: 'alb', label: 'Application Load Balancer', group: 'Edge & Web' },
  { id: 'apigw', label: 'Amazon API Gateway', group: 'Edge & Web' },
  { id: 'lambda', label: 'AWS Lambda', group: 'Compute' },
  { id: 'ecs-fargate', label: 'Amazon ECS on Fargate', group: 'Compute' },
  { id: 'eks', label: 'Amazon EKS', group: 'Compute' },
  { id: 'ec2', label: 'Amazon EC2', group: 'Compute' },
  { id: 'step-functions', label: 'AWS Step Functions', group: 'Integration' },
  { id: 'sqs', label: 'Amazon SQS', group: 'Integration' },
  { id: 'sns', label: 'Amazon SNS', group: 'Integration' },
  { id: 'eventbridge', label: 'Amazon EventBridge', group: 'Integration' },
  { id: 'kinesis', label: 'Amazon Kinesis Data Streams', group: 'Integration' },
  { id: 's3-data', label: 'Amazon S3 (data lake / documents)', group: 'Data' },
  { id: 'dynamodb', label: 'Amazon DynamoDB', group: 'Data' },
  { id: 'rds', label: 'Amazon RDS / Aurora', group: 'Data' },
  { id: 'elasticache', label: 'Amazon ElastiCache', group: 'Data' },
  { id: 'opensearch', label: 'Amazon OpenSearch Service', group: 'Data' },
  { id: 'glue-athena', label: 'AWS Glue / Amazon Athena', group: 'Data' },
  { id: 'redshift', label: 'Amazon Redshift', group: 'Data' },
  { id: 'bedrock', label: 'Amazon Bedrock (foundation models)', group: 'AI/ML' },
  { id: 'bedrock-kb', label: 'Amazon Bedrock Knowledge Bases (RAG)', group: 'AI/ML' },
  { id: 'bedrock-agents', label: 'Amazon Bedrock Agents / AgentCore', group: 'AI/ML' },
  { id: 'sagemaker', label: 'Amazon SageMaker AI', group: 'AI/ML' },
  { id: 'textract', label: 'Amazon Textract / Comprehend', group: 'AI/ML' },
  { id: 'cognito', label: 'Amazon Cognito', group: 'Identity & Security' },
  { id: 'identity-center', label: 'IAM Identity Center / corporate SSO', group: 'Identity & Security' },
  { id: 'secrets-manager', label: 'AWS Secrets Manager', group: 'Identity & Security' },
  { id: 'kms', label: 'AWS KMS', group: 'Identity & Security' },
  { id: 'vpc-privatelink', label: 'VPC / PrivateLink endpoints', group: 'Network' },
  { id: 'vpn-dx', label: 'Site-to-Site VPN / Direct Connect', group: 'Network' },
  { id: 'saas-api', label: 'Third-party SaaS API', group: 'External' },
  { id: 'onprem', label: 'On-premises system integration', group: 'External' },
] as const;

export const DATA_CLASSIFICATIONS = [
  { id: 'public', label: 'Public information' },
  { id: 'internal', label: 'Internal business data (synthetic)' },
  { id: 'confidential', label: 'Confidential business data (synthetic)' },
  { id: 'pii', label: 'Personal data / PII (synthetic)' },
  { id: 'health', label: 'Health or clinical-like data (synthetic)' },
  { id: 'credentials', label: 'Credentials, keys, or secrets' },
  { id: 'financial', label: 'Financial data (synthetic)' },
] as const;

export const EXPOSURES = [
  { id: 'internet', label: 'Internet-facing (public users)' },
  { id: 'partner', label: 'Partner / vendor-facing' },
  { id: 'internal', label: 'Internal employees only' },
  { id: 'batch', label: 'No user interface (batch / back-end)' },
] as const;

export type ComponentId = (typeof COMPONENTS)[number]['id'];
export type DataClassId = (typeof DATA_CLASSIFICATIONS)[number]['id'];
export type ExposureId = (typeof EXPOSURES)[number]['id'];

export const LIMITS = {
  titleMin: 3,
  titleMax: 120,
  descriptionMin: 40,
  descriptionMax: 6000,
  maxComponents: 25,
  maxBodyBytes: 16_000,
} as const;
