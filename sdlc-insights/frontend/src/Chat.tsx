import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Api, describeError } from './api';
import { Md } from './Md';

interface ToolCall { name: string; input: unknown; result: unknown; ms: number }
interface Job { messageId: string; status: 'PENDING' | 'COMPLETE' | 'FAILED' | 'BLOCKED'; answer?: string; reasoning?: string; toolCalls?: ToolCall[]; errorMessage?: string; durationMs?: number; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
interface Turn { question: string; job?: Job; error?: string }

export const SUGGESTIONS = [
  'Give me a one-paragraph overview of the Secure SDLC Advisor architecture.',
  'How many different types of AWS resources are deployed right now, across both applications?',
  'Which LLM does each application use, and why?',
  'Where does the Advisor get its data, and where is it stored?',
  'Show me the most recent LLM reasoning logs from the Advisor.',
  'Were there any errors in the Advisor worker logs in the last 24 hours?',
  'What went wrong during the first deployment and how was it fixed?',
  'How is prompt injection mitigated in the Advisor?',
  'What are the main cost drivers and how many Bedrock tokens have been used today?',
  'How does the chatbot avoid exposing API keys or secrets?',
];

/** Build Converse-compatible history (alternating user/assistant) from completed turns, bounded in size. */
export function buildHistory(turns: Turn[], maxTurns = 4) {
  const done = turns.filter((t) => t.job?.status === 'COMPLETE' && t.job.answer).slice(-maxTurns);
  return done.flatMap((t) => [{ role: 'user' as const, text: t.question.slice(0, 1000) }, { role: 'assistant' as const, text: t.job!.answer!.slice(0, 3500) }]);
}

const toolLabel: Record<string, string> = {
  get_resource_inventory: 'CloudFormation resource inventory', get_deployment_events: 'CloudFormation deployment events', query_logs: 'CloudWatch logs',
  get_llm_reasoning_logs: 'LLM reasoning logs', get_metrics: 'CloudWatch metrics', get_alarms: 'CloudWatch alarms',
};

export function Chat({ api }: { api: Api }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (text.length < 2 || busy) return;
    setBusy(true); setQ('');
    const history = buildHistory(turns);
    const idx = turns.length;
    setTurns((t) => [...t, { question: text }]);
    const update = (patch: Partial<Turn>) => setTurns((t) => t.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
    try {
      const { messageId } = await api.post<{ messageId: string }>('/chat', { question: text, history });
      const started = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const job = await api.get<Job>(`/chat/${messageId}`);
        update({ job });
        if (job.status !== 'PENDING') break;
        if (Date.now() - started > 240_000) { update({ error: 'Timed out waiting for an answer.' }); break; }
      }
    } catch (e) { update({ error: describeError(e) }); }
    finally { setBusy(false); }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void ask(q); };

  return (
    <div className="chat">
      {turns.length === 0 && (
        <div className="card intro">
          <h1>Ask about this class deployment</h1>
          <p className="muted">The assistant reads <code>projectknowledge.md</code> and can fetch live data from CloudFormation, CloudWatch logs, metrics, alarms and LLM reasoning logs. Try one of these:</p>
          <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => void ask(s)}>{s}</button>)}</div>
        </div>
      )}
      <ol className="turns" aria-live="polite">
        {turns.map((t, i) => (
          <li key={i} className="turn">
            <div className="bubble user"><span className="visually-hidden">You asked: </span>{t.question}</div>
            <div className="bubble bot">
              {t.error ? <p className="alert error" role="alert">{t.error}</p>
                : !t.job || t.job.status === 'PENDING' ? <p className="thinking"><span className="dot" /><span className="dot" /><span className="dot" /> Thinking and fetching data…</p>
                : t.job.status !== 'COMPLETE' ? <p className="alert error" role="alert">{t.job.errorMessage}</p>
                : (
                  <>
                    <Md>{t.job.answer ?? ''}</Md>
                    <p className="meta muted small">
                      {(t.job.durationMs! / 1000).toFixed(1)}s · {t.job.usage?.inputTokens ?? 0} in / {t.job.usage?.outputTokens ?? 0} out tokens
                      {t.job.usage?.cacheReadTokens ? ` · ${t.job.usage.cacheReadTokens} from prompt cache` : ''}
                    </p>
                    {!!t.job.toolCalls?.length && (
                      <details className="disclosure">
                        <summary>Data fetched from AWS ({t.job.toolCalls.length} call{t.job.toolCalls.length > 1 ? 's' : ''})</summary>
                        {t.job.toolCalls.map((c, j) => (
                          <div key={j} className="toolcall">
                            <div><strong>{toolLabel[c.name] ?? c.name}</strong> <code>{c.name}({JSON.stringify(c.input)})</code> <span className="muted small">{c.ms} ms</span></div>
                            <pre>{JSON.stringify(c.result, null, 2)}</pre>
                          </div>
                        ))}
                      </details>
                    )}
                    {t.job.reasoning && (
                      <details className="disclosure">
                        <summary>Model reasoning (extended thinking)</summary>
                        <pre className="reasoning">{t.job.reasoning}</pre>
                      </details>
                    )}
                  </>
                )}
            </div>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
      <form className="ask" onSubmit={submit}>
        <label htmlFor="q" className="visually-hidden">Your question</label>
        <textarea id="q" rows={2} maxLength={1000} value={q} placeholder="Ask anything about the design, deployment, resources, logs or LLMs…"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(q); } }} />
        <button className="btn primary" disabled={busy || q.trim().length < 2}>{busy ? 'Working…' : 'Ask'}</button>
        {turns.length > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={() => setTurns([])}>New chat</button>}
      </form>
    </div>
  );
}
