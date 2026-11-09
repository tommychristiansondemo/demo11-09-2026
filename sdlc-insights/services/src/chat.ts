import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand, type Message, type ContentBlock, type SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from './lib/log';
import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS } from './lib/chat-prompt';
import { loadConfig, getKnowledge, queryLogs, reasoningLogs, inventory, stackEvents, metrics, alarms, METRIC_NAMES, type ToolConfig } from './lib/tools';
import { writeReasoningLog, extractReasoning, promptVersion } from './lib/reasoning';
import { sanitizeText } from './lib/sanitize';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const bedrock = new BedrockRuntimeClient({ maxAttempts: 4 });
const TABLE = process.env.TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const THINKING_BUDGET = Number(process.env.THINKING_BUDGET_TOKENS ?? '1024');
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? '3000');
const MAX_TOOL_ROUNDS = 5;
const PROMPT_VERSION = promptVersion(CHAT_SYSTEM_PROMPT);

export interface ChatJob {
  userId: string; messageId: string; status: 'PENDING' | 'COMPLETE' | 'FAILED' | 'BLOCKED';
  createdAt: string; expiresAt: number;
  question: string; history: { role: 'user' | 'assistant'; text: string }[];
  answer?: string; reasoning?: string; toolCalls?: { name: string; input: unknown; result: unknown; ms: number }[];
  errorMessage?: string; durationMs?: number; modelId?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export function boundJson(value: unknown, max: number): unknown {
  const str = JSON.stringify(value) ?? 'null';
  return str.length <= max ? value : { truncated: true, originalChars: str.length, preview: str.slice(0, max) };
}

export async function runTool(cfg: ToolConfig, name: string, input: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'get_resource_inventory': return inventory(cfg, { stack: input.stack, detail: Boolean(input.detail) });
    case 'get_deployment_events': return stackEvents(cfg, input);
    case 'query_logs': return queryLogs(cfg, input);
    case 'get_llm_reasoning_logs': return reasoningLogs(cfg, input);
    case 'get_metrics': return metrics(cfg, input);
    case 'get_alarms': return alarms(cfg);
    default: return { error: `Unknown tool ${name}` };
  }
}

function toolSpecs(cfg: ToolConfig) {
  return CHAT_TOOLS.map((t) => {
    let description: string = t.description;
    if (t.name === 'query_logs') description += ` Valid sources: ${Object.keys(cfg.logGroups).join(', ')}.`;
    if (t.name === 'get_metrics') description += ` Valid names: ${METRIC_NAMES.join(', ')}.`;
    if (t.name === 'get_deployment_events' || t.name === 'get_resource_inventory') description += ` Stacks: ${cfg.stacks.map((s) => s.name).join(', ')}.`;
    return { toolSpec: { name: t.name, description, inputSchema: { json: t.schema as never } } };
  });
}

async function finish(job: { userId: string; messageId: string }, fields: Record<string, unknown>) {
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = { ':pending': 'PENDING' };
  const sets = Object.entries(fields).map(([k, v]) => { names[`#${k}`] = k; values[`:${k}`] = v; return `#${k} = :${k}`; });
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { userId: job.userId, messageId: job.messageId },
    UpdateExpression: 'SET ' + sets.join(', '), ConditionExpression: '#status = :pending',
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}

export const handler = async (e: { userId: string; messageId: string; correlationId: string }) => {
  const log = createLogger({ correlationId: e.correlationId, messageId: e.messageId, component: 'chat' });
  const started = Date.now();
  const got = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId: e.userId, messageId: e.messageId } }));
  const job = got.Item as ChatJob | undefined;
  if (!job || job.status !== 'PENDING') { log.warn('job missing or not pending'); return; }
  const cfg = loadConfig();

  try {
    const knowledge = await getKnowledge(cfg);
    const system: SystemContentBlock[] = [
      { text: CHAT_SYSTEM_PROMPT },
      { text: `<project_knowledge last_modified="${knowledge.lastModified}">\n${knowledge.text}\n</project_knowledge>` },
      { cachePoint: { type: 'default' } } as SystemContentBlock,
    ];
    const guarded = Boolean(GUARDRAIL_ID && GUARDRAIL_VERSION);
    const messages: Message[] = [
      ...job.history.map((h) => ({ role: h.role, content: [{ text: h.text }] }) as Message),
      { role: 'user', content: [guarded ? { guardContent: { text: { text: job.question } } } : { text: job.question }] as ContentBlock[] },
    ];
    const toolCalls: NonNullable<ChatJob['toolCalls']> = [];
    const reasoningParts: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let answer = '';

    for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round++) {
      const lastRound = round > MAX_TOOL_ROUNDS;
      const t0 = Date.now();
      const resp = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID, system, messages,
        inferenceConfig: { maxTokens: MAX_TOKENS + THINKING_BUDGET },
        additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET } } as never,
        toolConfig: { tools: toolSpecs(cfg), toolChoice: lastRound ? undefined : { auto: {} } } as never,
        guardrailConfig: guarded ? { guardrailIdentifier: GUARDRAIL_ID!, guardrailVersion: GUARDRAIL_VERSION!, trace: 'disabled' } : undefined,
      }));
      const content = (resp.output?.message?.content ?? []) as Array<Record<string, any>>;
      usage.inputTokens += resp.usage?.inputTokens ?? 0;
      usage.outputTokens += resp.usage?.outputTokens ?? 0;
      usage.cacheReadTokens += resp.usage?.cacheReadInputTokens ?? 0;
      const reasoning = extractReasoning(content);
      if (reasoning) reasoningParts.push(reasoning);
      const uses = content.filter((c) => c.toolUse).map((c) => c.toolUse);
      writeReasoningLog({
        app: 'class-insights-chat', correlationId: e.correlationId, subjectId: e.messageId, modelId: MODEL_ID, promptVersion: PROMPT_VERSION,
        attempt: round, thinkingEnabled: true, stopReason: resp.stopReason,
        guardrailAction: resp.stopReason === 'guardrail_intervened' ? 'INTERVENED' : 'NONE',
        inputTokens: resp.usage?.inputTokens, outputTokens: resp.usage?.outputTokens, latencyMs: resp.metrics?.latencyMs ?? Date.now() - t0,
        toolCalls: uses.map((u) => u.name), reasoning,
      });

      if (resp.stopReason === 'guardrail_intervened') {
        await finish(e, { status: 'BLOCKED', errorMessage: 'The content safety guardrail blocked this question. Please rephrase it.', durationMs: Date.now() - started, modelId: MODEL_ID });
        log.metric({ ChatGuardrailBlocks: 1 });
        return;
      }
      if (resp.stopReason !== 'tool_use' || uses.length === 0) {
        answer = content.filter((c) => typeof c.text === 'string').map((c) => c.text).join('\n').trim();
        break;
      }
      messages.push(resp.output!.message!);
      const results: ContentBlock[] = [];
      for (const u of uses) {
        const s = Date.now();
        let result: unknown;
        try { result = await runTool(cfg, u.name, u.input ?? {}); } catch (err) { result = { error: `Tool failed: ${(err as Error).name}` }; }
        const ms = Date.now() - s;
        toolCalls.push({ name: u.name, input: u.input, result, ms });
        log.info('tool call', { tool: u.name, ms });
        results.push({ toolResult: { toolUseId: u.toolUseId, content: [{ json: result as never }] } } as ContentBlock);
      }
      messages.push({ role: 'user', content: results });
    }

    if (!answer) answer = 'I could not produce an answer. Please try rephrasing the question.';
    const durationMs = Date.now() - started;
    // Tool results can be large; store a bounded copy for the "data fetched" panel (DynamoDB items max 400 KB).
    let budget = 250_000;
    const storedCalls = toolCalls.map((c) => {
      const result = boundJson(c.result, Math.max(2_000, Math.min(60_000, budget)));
      budget -= JSON.stringify(result).length;
      return { ...c, result };
    });
    await finish(e, {
      status: 'COMPLETE', answer: sanitizeText(answer, 20_000), reasoning: sanitizeText(reasoningParts.join('\n---\n'), 8000),
      toolCalls: storedCalls, durationMs, modelId: MODEL_ID, usage,
    });
    log.info('chat complete', { durationMs, tools: toolCalls.map((c) => c.name), ...usage });
    log.metric({ ChatQuestions: 1, ChatDurationMs: durationMs, InputTokens: usage.inputTokens, OutputTokens: usage.outputTokens, CacheReadTokens: usage.cacheReadTokens, ToolCalls: toolCalls.length }, { ChatDurationMs: 'Milliseconds' });
  } catch (err) {
    log.error('chat failed', { errorName: (err as Error).name, errorMessage: (err as Error).message?.slice(0, 300) });
    log.metric({ ChatFailures: 1 });
    await finish(e, { status: 'FAILED', errorMessage: 'The assistant could not answer right now. Please try again.', durationMs: Date.now() - started }).catch(() => undefined);
  }
};
