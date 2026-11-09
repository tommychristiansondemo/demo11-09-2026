import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from './lib/log';
import { SYSTEM_PROMPT, ASSESSMENT_TOOL_SCHEMA, buildContextText, buildDescriptionText } from './lib/prompt';
import { normaliseResult, ResultShapeError } from './lib/result';
import { ASSESSMENT_ID_RE } from './lib/validation';
import { writeReasoningLog, extractReasoning, promptVersion } from './lib/reasoning';
import type { StoredAssessment } from './api';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const bedrock = new BedrockRuntimeClient({ maxAttempts: 4 });

const TABLE = process.env.TABLE_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? '8000');
const THINKING_BUDGET = Number(process.env.THINKING_BUDGET_TOKENS ?? '0');
const PROMPT_VERSION = promptVersion(SYSTEM_PROMPT);

interface WorkerEvent { userId: string; assessmentId: string; correlationId: string }

export function buildConverseRequest(item: StoredAssessment, thinking = THINKING_BUDGET > 0): ConverseCommandInput {
  const guarded = Boolean(GUARDRAIL_ID && GUARDRAIL_VERSION);
  const description = buildDescriptionText(item.input);
  const req: ConverseCommandInput = {
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: [
        { text: buildContextText(item.input) },
        // Only the untrusted, user-authored description is wrapped in guardContent so the
        // guardrail's prompt-attack filter evaluates exactly the user-supplied data.
        guarded ? { guardContent: { text: { text: description } } } : { text: description },
      ],
    }],
    // Extended thinking cannot be combined with a forced tool choice or a custom temperature.
    inferenceConfig: thinking ? { maxTokens: MAX_OUTPUT_TOKENS + THINKING_BUDGET } : { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
    toolConfig: {
      tools: [{ toolSpec: { name: 'submit_assessment', description: 'Submit the completed security assessment.', inputSchema: { json: ASSESSMENT_TOOL_SCHEMA as never } } }],
      toolChoice: thinking ? { auto: {} } : { tool: { name: 'submit_assessment' } },
    },
  };
  if (thinking) req.additionalModelRequestFields = { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET } } as never;
  if (guarded) {
    req.guardrailConfig = { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION, trace: 'disabled' };
  }
  return req;
}

async function finish(e: WorkerEvent, fields: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':pending': 'PENDING' };
  const sets = Object.entries({ ...fields, updatedAt: new Date().toISOString() }).map(([k, v]) => {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    return `#${k} = :${k}`;
  });
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { userId: e.userId, assessmentId: e.assessmentId },
    UpdateExpression: 'SET ' + sets.join(', '),
    ConditionExpression: 'attribute_exists(userId) AND #status = :pending',
    ExpressionAttributeNames: { ...names, '#status': 'status' },
    ExpressionAttributeValues: values,
  }));
}

export const handler = async (e: WorkerEvent): Promise<void> => {
  const log = createLogger({ correlationId: e.correlationId, assessmentId: e.assessmentId, component: 'worker' });
  if (!e?.userId || !ASSESSMENT_ID_RE.test(e.assessmentId ?? '')) {
    log.error('invalid worker event');
    return;
  }
  const started = Date.now();
  const got = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId: e.userId, assessmentId: e.assessmentId } }));
  const item = got.Item as StoredAssessment | undefined;
  if (!item || item.status !== 'PENDING') {
    log.warn('item missing or not pending', { status: item?.status });
    return;
  }

  try {
    // Attempt 1 uses extended thinking (tool choice "auto"); if the model does not call the tool,
    // attempt 2 forces the tool without thinking.
    let resp;
    let toolUse;
    const attempts = THINKING_BUDGET > 0 ? [true, false] : [false];
    for (const [i, thinking] of attempts.entries()) {
      const t0 = Date.now();
      resp = await bedrock.send(new ConverseCommand(buildConverseRequest(item, thinking)));
      const content = (resp.output?.message?.content ?? []) as Array<Record<string, any>>;
      toolUse = content.find((c) => c.toolUse)?.toolUse;
      writeReasoningLog({
        app: 'secure-sdlc-advisor', correlationId: e.correlationId, subjectId: e.assessmentId, modelId: MODEL_ID,
        promptVersion: PROMPT_VERSION, attempt: i + 1, thinkingEnabled: thinking, stopReason: resp.stopReason,
        guardrailAction: resp.stopReason === 'guardrail_intervened' ? 'INTERVENED' : 'NONE',
        inputTokens: resp.usage?.inputTokens, outputTokens: resp.usage?.outputTokens, latencyMs: resp.metrics?.latencyMs ?? Date.now() - t0,
        toolCalls: content.filter((c) => c.toolUse).map((c) => c.toolUse.name),
        reasoning: extractReasoning(content),
        note: toolUse ? undefined : 'No tool call returned',
      });
      if (toolUse || resp.stopReason === 'guardrail_intervened') break;
    }
    resp = resp!;
    const durationMs = Date.now() - started;
    const usage: { inputTokens?: number; outputTokens?: number } = resp.usage ?? {};
    log.metric(
      { BedrockLatencyMs: resp.metrics?.latencyMs ?? durationMs, InputTokens: usage.inputTokens ?? 0, OutputTokens: usage.outputTokens ?? 0 },
      { BedrockLatencyMs: 'Milliseconds' },
    );

    if (resp.stopReason === 'guardrail_intervened') {
      log.warn('guardrail intervened', { durationMs });
      log.metric({ GuardrailBlocks: 1 });
      await finish(e, { status: 'BLOCKED', errorMessage: 'The content safety guardrail blocked this request. Remove any instructions aimed at the AI, sensitive data, or harmful content and try again.', durationMs, modelId: MODEL_ID });
      return;
    }
    if (!toolUse) throw new ResultShapeError(`No tool output (stopReason=${resp.stopReason})`);
    const result = normaliseResult(toolUse.input);
    await finish(e, { status: 'COMPLETE', result, durationMs, modelId: MODEL_ID });
    log.info('assessment complete', {
      durationMs, stopReason: resp.stopReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      threats: result.threats.length, checklist: result.checklist.length,
    });
    log.metric({ AssessmentsCompleted: 1, AssessmentDurationMs: durationMs }, { AssessmentDurationMs: 'Milliseconds' });
  } catch (err) {
    const name = (err as Error).name;
    log.error('assessment failed', { errorName: name, errorMessage: (err as Error).message?.slice(0, 300) });
    log.metric({ AssessmentsFailed: 1 });
    const userMsg = name === 'ThrottlingException' || name === 'ServiceQuotaExceededException'
      ? 'The AI service is busy. Please try again in a minute.'
      : name === 'ResultShapeError'
        ? 'The AI response was incomplete. Please try again.'
        : 'The assessment could not be generated. Please try again.';
    try {
      await finish(e, { status: 'FAILED', errorMessage: userMsg, durationMs: Date.now() - started });
    } catch (e2) {
      log.error('could not record failure', { errorName: (e2 as Error).name });
    }
  }
};
