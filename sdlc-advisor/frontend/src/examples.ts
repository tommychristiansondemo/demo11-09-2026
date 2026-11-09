// Fully synthetic sample applications for classroom demonstrations.
// They describe fictional systems and contain no real company, patient or production data.
export interface Example { id: string; title: string; exposure: string; components: string[]; dataClassifications: string[]; description: string }

export const EXAMPLES: Example[] = [
  {
    id: 'lab-scheduler',
    title: 'Lab Equipment Booking Portal',
    exposure: 'internal',
    components: ['cloudfront', 'waf', 's3-static', 'apigw', 'lambda', 'dynamodb', 'cognito', 'identity-center', 'eventbridge', 'sns'],
    dataClassifications: ['internal'],
    description: `A fictional internal web portal that lets research staff reserve shared laboratory instruments (centrifuges, plate readers, microscopes) by the hour.
Employees sign in through corporate SSO federated into Amazon Cognito. A React single-page app is served from S3 through CloudFront.
API Gateway and Lambda implement booking CRUD operations, conflict detection and an approval step for high-demand instruments. Bookings are stored in DynamoDB.
An EventBridge schedule sends reminder notifications through SNS 24 hours before a booking. Lab managers can export monthly utilisation reports as CSV.
Expected load: about 400 users, peaks of 20 requests per second on Monday mornings. All sample data in this exercise is synthetic.`,
  },
  {
    id: 'trial-faq-assistant',
    title: 'Public Study FAQ Assistant (GenAI)',
    exposure: 'internet',
    components: ['cloudfront', 'waf', 's3-static', 'apigw', 'lambda', 'bedrock', 'bedrock-kb', 's3-data', 'opensearch', 'dynamodb'],
    dataClassifications: ['public', 'pii'],
    description: `A fictional public-facing chatbot that answers general questions about how research studies work, using only publicly available, synthetic FAQ documents.
Documents are uploaded by a content team to an S3 bucket and indexed into a Bedrock Knowledge Base backed by OpenSearch Serverless.
Anonymous visitors chat through a web widget; API Gateway + Lambda call a Bedrock foundation model with retrieval-augmented generation and return answers with citations.
Visitors may optionally leave a name and email address (synthetic in this exercise) to request a call-back; these are stored in DynamoDB for 30 days.
Conversation transcripts are retained for 7 days for quality review. The team is concerned about prompt injection, hallucinated medical advice and abuse/cost spikes from bots.`,
  },
  {
    id: 'invoice-pipeline',
    title: 'Supplier Invoice Processing Pipeline',
    exposure: 'partner',
    components: ['apigw', 'lambda', 's3-data', 'textract', 'step-functions', 'sqs', 'rds', 'secrets-manager', 'kms', 'saas-api', 'vpc-privatelink'],
    dataClassifications: ['confidential', 'financial'],
    description: `A fictional pipeline where external suppliers upload PDF invoices through a partner API protected by API keys.
Files land in an S3 bucket; an S3 event starts a Step Functions workflow that extracts fields with Amazon Textract, validates totals against purchase orders in an Aurora PostgreSQL database inside a private VPC, and queues exceptions in SQS for a finance analyst.
Approved invoices are posted to a third-party SaaS ERP over HTTPS using OAuth client credentials stored in Secrets Manager.
About 2,000 invoices per day, peaks at month end. Invoices and bank details in this exercise are synthetic.`,
  },
  {
    id: 'sensor-telemetry',
    title: 'Manufacturing Sensor Telemetry Dashboard',
    exposure: 'internal',
    components: ['kinesis', 'lambda', 's3-data', 'glue-athena', 'ecs-fargate', 'alb', 'elasticache', 'vpn-dx', 'onprem', 'identity-center'],
    dataClassifications: ['internal', 'confidential'],
    description: `A fictional system that streams temperature, humidity and vibration readings from on-premises plant equipment over Site-to-Site VPN into Kinesis Data Streams.
A Lambda consumer detects out-of-range readings and raises alerts; raw data lands in S3 and is queried with Glue and Athena for trend analysis.
Operators view a real-time dashboard served by a containerised web app on ECS Fargate behind an internal Application Load Balancer, with ElastiCache for recent readings.
Plant gateways authenticate with long-lived device certificates. Availability matters: a 15-minute outage delays batch-quality decisions. All telemetry here is synthetic.`,
  },
  {
    id: 'hr-onboarding-agent',
    title: 'Employee Onboarding Agent (GenAI)',
    exposure: 'internal',
    components: ['cloudfront', 'apigw', 'lambda', 'bedrock', 'bedrock-agents', 'dynamodb', 'cognito', 'identity-center', 'saas-api', 'secrets-manager'],
    dataClassifications: ['internal', 'pii'],
    description: `A fictional AI agent that helps new hires complete onboarding tasks. Signed-in employees chat with an agent that can look up their (synthetic) onboarding checklist in DynamoDB, open IT tickets in a third-party SaaS service desk, and book orientation sessions in a calendar API.
The agent uses tool calls whose credentials are stored in Secrets Manager. Managers can ask the agent for the status of their direct reports.
Conversation history is kept for 14 days. Key concerns: the agent acting on behalf of the wrong user, excessive tool permissions, and leaking one employee's details to another.`,
  },
];
