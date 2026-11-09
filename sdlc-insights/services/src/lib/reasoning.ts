import { createHash } from 'node:crypto';
import { redact } from './redact';

// Structured "LLM reasoning log" records. One per model invocation, written to the function's
// CloudWatch log group with type="llm_reasoning" so the Class Insights app can query them with a
// metric filter pattern. By design these records contain the model's reasoning summary and invocation
// metadata — never the complete prompt or the generated report.

export const promptVersion = (systemPrompt: string) => createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12);

export interface ReasoningRecord {
  app: string;
  correlationId: string;
  subjectId?: string; // assessment or chat message id
  modelId: string;
  promptVersion: string;
  attempt: number;
  thinkingEnabled: boolean;
  stopReason?: string;
  guardrailAction?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  toolCalls?: string[];
  reasoning?: string;
  note?: string;
}

export function extractReasoning(content: Array<Record<string, any>> | undefined): string {
  return (content ?? [])
    .map((c) => c.reasoningContent?.reasoningText?.text as string | undefined)
    .filter(Boolean)
    .join('\n---\n');
}

export function writeReasoningLog(r: ReasoningRecord) {
  const reasoning = r.reasoning ? redact(r.reasoning).text.slice(0, 6000) : undefined;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', type: 'llm_reasoning', ...r, reasoning, reasoningChars: r.reasoning?.length ?? 0 }));
}
