import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { createLogger, correlationIdFrom } from './lib/log';
import { loadConfig, getKnowledge, inventory, queryLogs, reasoningLogs, metrics, alarms, stackEvents } from './lib/tools';
import { redact } from './lib/redact';
import type { ChatJob } from './chat';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const lambda = new LambdaClient({});
const TABLE = process.env.TABLE_NAME!;
const CHAT_FN = process.env.CHAT_FUNCTION_NAME!;
const ORIGIN_VERIFY = process.env.ORIGIN_VERIFY ?? '';
const MAX_BODY = 16_000;
const ID_RE = /^[0-9]{17}[a-f0-9]{8}$/;

export function fromCloudFront(h: string | undefined, expected = ORIGIN_VERIFY) {
  if (!expected) return false;
  const a = Buffer.from(h ?? ''); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (status: number, body: unknown, cid: string): APIGatewayProxyResult => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Correlation-Id': cid },
  body: JSON.stringify(body),
});
const err = (s: number, code: string, message: string, cid: string, issues?: string[]) => json(s, { error: { code, message, correlationId: cid, issues } }, cid);

export interface ChatInput { question: string; history: { role: 'user' | 'assistant'; text: string }[] }
export function parseChat(raw: unknown): ChatInput | string[] {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['Body must be a JSON object.'];
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['question', 'history'].includes(k)) issues.push(`Unexpected field: ${k.slice(0, 30)}`);
  // eslint-disable-next-line no-control-regex
  const clean = (s: string) => s.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
  const question = typeof b.question === 'string' ? clean(b.question) : '';
  if (question.length < 2 || question.length > 1000) issues.push('question must be 2-1000 characters.');
  const history = Array.isArray(b.history) ? b.history : b.history === undefined ? [] : null;
  if (!history || history.length > 10) issues.push('history must be an array of at most 10 messages.');
  const h: ChatInput['history'] = [];
  for (const m of history ?? []) {
    const mm = m as Record<string, unknown>;
    if (!mm || (mm.role !== 'user' && mm.role !== 'assistant') || typeof mm.text !== 'string' || mm.text.length > 4000) { issues.push('history entries need role user|assistant and text ≤ 4000 chars.'); break; }
    h.push({ role: mm.role, text: clean(mm.text) || '(empty)' });
  }
  // Conversation must alternate and start with the user for the Converse API.
  for (let i = 0; i < h.length; i++) if (h[i].role !== (i % 2 === 0 ? 'user' : 'assistant')) { issues.push('history must alternate user/assistant, starting with user.'); break; }
  if (h.length % 2 !== 0) issues.push('history must end with an assistant message.');
  return issues.length ? issues : { question: redact(question).text, history: h.map((m) => ({ ...m, text: redact(m.text).text })) };
}

const newId = () => new Date().toISOString().replace(/[-:.TZ]/g, '') + randomBytes(4).toString('hex');

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const started = Date.now();
  const cid = correlationIdFrom(event.headers?.['x-correlation-id'] ?? event.headers?.['X-Correlation-Id'], event.requestContext?.requestId ?? 'none');
  const route = `${event.httpMethod} ${event.resource}`;
  const log = createLogger({ correlationId: cid, route });
  if (!fromCloudFront(event.headers?.['x-origin-verify'])) return err(403, 'FORBIDDEN', 'Direct API access is not permitted.', cid);
  const userId: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  const q = event.queryStringParameters ?? {};
  const cfg = loadConfig();
  let resp: APIGatewayProxyResult;
  try {
    if (route === 'GET /api/health') resp = json(200, { status: 'ok', service: 'sdlc-class-insights', time: new Date().toISOString() }, cid);
    else if (!userId) resp = err(401, 'UNAUTHENTICATED', 'Sign in required.', cid);
    else switch (route) {
      case 'GET /api/knowledge': {
        const k = await getKnowledge(cfg, 30_000);
        resp = json(200, { markdown: k.text, lastModified: k.lastModified, versionId: k.versionId }, cid); break;
      }
      case 'GET /api/inventory': resp = json(200, await inventory(cfg, { detail: q.detail === 'true' }), cid); break;
      case 'GET /api/events': resp = json(200, await stackEvents(cfg, { stack: q.stack, limit: Number(q.limit ?? 30) }), cid); break;
      case 'GET /api/logs': resp = json(200, await queryLogs(cfg, { source: q.source, minutes: Number(q.minutes ?? 60), filter: q.filter, limit: Number(q.limit ?? 30) }), cid); break;
      case 'GET /api/reasoning': resp = json(200, await reasoningLogs(cfg, { app: q.app, hours: Number(q.hours ?? 24), limit: Number(q.limit ?? 15) }), cid); break;
      case 'GET /api/metrics': resp = json(200, { ...(await metrics(cfg, { hours: Number(q.hours ?? 24) })), ...(await alarms(cfg)) }, cid); break;
      case 'GET /api/sources': resp = json(200, { logSources: Object.keys(cfg.logGroups), stacks: cfg.stacks }, cid); break;
      case 'POST /api/chat': {
        const body = event.body ?? '';
        if (Buffer.byteLength(body) > MAX_BODY) { resp = err(413, 'PAYLOAD_TOO_LARGE', 'Request too large.', cid); break; }
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { resp = err(400, 'INVALID_JSON', 'Body is not valid JSON.', cid); break; }
        const input = parseChat(parsed);
        if (Array.isArray(input)) { resp = err(400, 'VALIDATION_FAILED', 'The request is invalid.', cid, input); break; }
        const now = new Date();
        const job: ChatJob = { userId, messageId: newId(), status: 'PENDING', createdAt: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + 86_400, ...input };
        await ddb.send(new PutCommand({ TableName: TABLE, Item: job }));
        await lambda.send(new InvokeCommand({ FunctionName: CHAT_FN, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ userId, messageId: job.messageId, correlationId: cid })) }));
        log.info('chat queued', { messageId: job.messageId, questionChars: input.question.length, historyLen: input.history.length });
        resp = json(202, { messageId: job.messageId, status: 'PENDING' }, cid); break;
      }
      case 'GET /api/chat/{id}': {
        const id = event.pathParameters?.id ?? '';
        if (!ID_RE.test(id)) { resp = err(400, 'INVALID_ID', 'Invalid id.', cid); break; }
        const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId, messageId: id } }));
        const job = r.Item as ChatJob | undefined;
        if (!job) { resp = err(404, 'NOT_FOUND', 'Not found.', cid); break; }
        if (job.status === 'PENDING' && Date.now() - Date.parse(job.createdAt) > 4 * 60_000) { job.status = 'FAILED'; job.errorMessage = 'Timed out. Please try again.'; }
        const { userId: _u, history: _h, ...rest } = job;
        resp = json(200, rest, cid); break;
      }
      default: resp = err(404, 'NOT_FOUND', 'Route not found.', cid);
    }
  } catch (e) {
    log.error('unhandled', { errorName: (e as Error).name, errorMessage: (e as Error).message?.slice(0, 300) });
    resp = err(500, 'INTERNAL', 'Unexpected error. Quote the correlation ID if you report this.', cid);
  }
  log.info('request complete', { status: resp.statusCode, durationMs: Date.now() - started });
  return resp;
};
