import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { timingSafeEqual } from 'node:crypto';
import { createLogger, correlationIdFrom, type Logger } from './lib/log';
import { parseAssessmentInput, ValidationError, ASSESSMENT_ID_RE, type AssessmentInput } from './lib/validation';
import { redact } from './lib/redact';
import { newAssessmentId } from './lib/ids';
import { buildMarkdown } from './lib/markdown';
import { LIMITS } from './lib/catalog';
import type { AssessmentResult } from './lib/result';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const lambda = new LambdaClient({});

const TABLE = process.env.TABLE_NAME!;
const WORKER = process.env.WORKER_FUNCTION_NAME!;
const TTL_DAYS = Number(process.env.HISTORY_TTL_DAYS ?? '7');
const MAX_IN_FLIGHT = 3;
const VERSION = process.env.APP_VERSION ?? 'dev';
const ORIGIN_VERIFY = process.env.ORIGIN_VERIFY ?? '';

/** True when the request carries the secret header CloudFront adds, i.e. it passed through CloudFront + WAF. */
export function fromCloudFront(headerValue: string | undefined, expected = ORIGIN_VERIFY): boolean {
  if (!expected) return false;
  const a = Buffer.from(headerValue ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Resp = APIGatewayProxyResult;

function json(status: number, body: unknown, correlationId: string): Resp {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Correlation-Id': correlationId,
    },
    body: JSON.stringify(body),
  };
}

const err = (status: number, code: string, message: string, cid: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: { code, message, correlationId: cid, ...extra } }, cid);

export interface StoredAssessment {
  userId: string;
  assessmentId: string;
  status: 'PENDING' | 'COMPLETE' | 'FAILED' | 'BLOCKED';
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  input: AssessmentInput;
  redactions: number;
  result?: AssessmentResult;
  errorMessage?: string;
  modelId?: string;
  durationMs?: number;
}

function summary(item: StoredAssessment) {
  return {
    assessmentId: item.assessmentId,
    title: item.input.title,
    status: item.status,
    createdAt: item.createdAt,
    overallRisk: item.result?.overallRisk,
    expiresAt: new Date(item.expiresAt * 1000).toISOString(),
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<Resp> => {
  const started = Date.now();
  const cid = correlationIdFrom(event.headers?.['x-correlation-id'] ?? event.headers?.['X-Correlation-Id'], event.requestContext?.requestId ?? 'none');
  const route = `${event.httpMethod} ${event.resource}`;
  const userId: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  const log = createLogger({ correlationId: cid, route });
  let resp: Resp;
  if (!fromCloudFront(event.headers?.['x-origin-verify'] ?? event.headers?.['X-Origin-Verify'])) {
    log.warn('request did not come through CloudFront');
    return err(403, 'FORBIDDEN', 'Direct API access is not permitted.', cid);
  }
  try {
    resp = await dispatch(event, route, userId, cid, log);
  } catch (e) {
    log.error('Unhandled error', { errorName: (e as Error).name, errorMessage: (e as Error).message?.slice(0, 300) });
    resp = err(500, 'INTERNAL', 'An unexpected error occurred. Quote the correlation ID if you report this.', cid);
  }
  log.info('request complete', { status: resp.statusCode, durationMs: Date.now() - started, user: userId ? userId.slice(0, 8) : undefined });
  return resp;
};

async function dispatch(event: APIGatewayProxyEvent, route: string, userId: string | undefined, cid: string, log: Logger): Promise<Resp> {
  if (route === 'GET /api/health') {
    return json(200, { status: 'ok', service: 'secure-sdlc-advisor', version: VERSION, time: new Date().toISOString() }, cid);
  }
  if (!userId) return err(401, 'UNAUTHENTICATED', 'Sign in required.', cid);

  switch (route) {
    case 'POST /api/assessments':
      return createAssessment(event, userId, cid, log);
    case 'GET /api/assessments':
      return listAssessments(userId, cid);
    case 'GET /api/assessments/{id}':
      return getAssessment(event, userId, cid);
    case 'DELETE /api/assessments/{id}':
      return deleteAssessment(event, userId, cid);
    default:
      return err(404, 'NOT_FOUND', 'Route not found.', cid);
  }
}

async function createAssessment(event: APIGatewayProxyEvent, userId: string, cid: string, log: Logger): Promise<Resp> {
  const contentType = (event.headers?.['content-type'] ?? event.headers?.['Content-Type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', cid);
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  if (Buffer.byteLength(rawBody, 'utf8') > LIMITS.maxBodyBytes) return err(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${LIMITS.maxBodyBytes} bytes.`, cid);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return err(400, 'INVALID_JSON', 'Request body is not valid JSON.', cid);
  }
  let input: AssessmentInput;
  try {
    input = parseAssessmentInput(parsed);
  } catch (e) {
    if (e instanceof ValidationError) {
      log.warn('validation failed', { issueCount: e.issues.length });
      return err(400, 'VALIDATION_FAILED', 'The request is invalid.', cid, { issues: e.issues });
    }
    throw e;
  }

  // Redact BEFORE storing or sending anywhere.
  const t = redact(input.title);
  const d = redact(input.description);
  input = { ...input, title: t.text, description: d.text };
  const redactions = t.total + d.total;

  // Per-user in-flight limit (cost control + abuse protection).
  const recent = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'userId = :u',
    FilterExpression: '#s = :p',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':u': userId, ':p': 'PENDING' },
    ProjectionExpression: 'assessmentId, createdAt',
    ScanIndexForward: false,
    Limit: 25,
  }));
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const inFlight = (recent.Items ?? []).filter((i) => Date.parse(i.createdAt as string) > fiveMinAgo).length;
  if (inFlight >= MAX_IN_FLIGHT) {
    return err(429, 'TOO_MANY_IN_FLIGHT', `You already have ${inFlight} assessments running. Wait for one to finish.`, cid);
  }

  const now = new Date();
  const item: StoredAssessment = {
    userId,
    assessmentId: newAssessmentId(now),
    status: 'PENDING',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + TTL_DAYS * 86_400,
    input,
    redactions,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ userId, assessmentId: item.assessmentId, correlationId: cid })),
  }));
  log.info('assessment queued', { assessmentId: item.assessmentId, redactions, components: input.components.length, descriptionChars: input.description.length });
  log.metric({ AssessmentsRequested: 1, Redactions: redactions });
  return json(202, { assessmentId: item.assessmentId, status: item.status, redactions, createdAt: item.createdAt }, cid);
}

async function listAssessments(userId: string, cid: string): Promise<Resp> {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId, ':now': Math.floor(Date.now() / 1000) },
    FilterExpression: 'expiresAt > :now',
    ScanIndexForward: false,
    Limit: 50,
  }));
  return json(200, { items: ((out.Items ?? []) as StoredAssessment[]).map(summary) }, cid);
}

function idParam(event: APIGatewayProxyEvent): string | null {
  const id = event.pathParameters?.id ?? '';
  return ASSESSMENT_ID_RE.test(id) ? id : null;
}

async function getAssessment(event: APIGatewayProxyEvent, userId: string, cid: string): Promise<Resp> {
  const id = idParam(event);
  if (!id) return err(400, 'INVALID_ID', 'Invalid assessment id.', cid);
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId, assessmentId: id } }));
  const item = out.Item as StoredAssessment | undefined;
  if (!item || item.expiresAt < Date.now() / 1000) return err(404, 'NOT_FOUND', 'Assessment not found.', cid);
  // A worker that crashed hard could leave an item PENDING forever; surface it as failed.
  if (item.status === 'PENDING' && Date.now() - Date.parse(item.createdAt) > 6 * 60_000) {
    item.status = 'FAILED';
    item.errorMessage = 'The assessment timed out. Please try again.';
  }
  const markdown = item.status === 'COMPLETE' && item.result
    ? buildMarkdown(item.input, item.result, { id: item.assessmentId, createdAt: item.createdAt, modelId: item.modelId ?? 'unknown' })
    : undefined;
  return json(200, { ...summary(item), input: item.input, redactions: item.redactions, result: item.result, errorMessage: item.errorMessage, modelId: item.modelId, durationMs: item.durationMs, markdown }, cid);
}

async function deleteAssessment(event: APIGatewayProxyEvent, userId: string, cid: string): Promise<Resp> {
  const id = idParam(event);
  if (!id) return err(400, 'INVALID_ID', 'Invalid assessment id.', cid);
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { userId, assessmentId: id } }));
  return json(200, { deleted: true }, cid);
}
