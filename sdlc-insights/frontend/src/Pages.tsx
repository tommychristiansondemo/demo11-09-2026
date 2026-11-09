import { useCallback, useEffect, useState } from 'react';
import { Api, describeError } from './api';
import { Md } from './Md';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await fn()); } catch (e) { setError(describeError(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}

const Status = ({ error, loading }: { error: string; loading: boolean }) => (
  <>{loading && <p className="muted" aria-live="polite">Loading…</p>}{error && <p className="alert error" role="alert">{error}</p>}</>
);

export function Knowledge({ api }: { api: Api }) {
  const { data, error, loading } = useLoad(() => api.get<{ markdown: string; lastModified: string; versionId?: string }>('/knowledge'), []);
  const download = () => {
    const url = URL.createObjectURL(new Blob([data!.markdown], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'projectknowledge.md' });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <article className="card">
      <div className="row-between">
        <p className="muted small">Source: <code>s3://…/projectknowledge.md</code>{data && ` · updated ${new Date(data.lastModified).toLocaleString()}`}</p>
        {data && <button className="btn ghost" onClick={download}>Download .md</button>}
      </div>
      <Status error={error} loading={loading} />
      {data && <Md>{data.markdown}</Md>}
    </article>
  );
}

interface Inv { stacks: { stack: string; app: string; region: string; status: string; lastUpdated: string; resourceCount: number; resourceTypes: number; byType: Record<string, number> }[]; totals: { resources: number; distinctResourceTypes: number; distinctServices: number; services: string[]; byType: Record<string, number> } }
export function Inventory({ api }: { api: Api }) {
  const { data, error, loading, reload } = useLoad(() => api.get<Inv>('/inventory'), []);
  return (
    <div className="stack-gap">
      <div className="row-between"><h1>Live resource inventory</h1><button className="btn ghost" onClick={() => void reload()}>Refresh</button></div>
      <p className="muted">Read live from CloudFormation (<code>ListStackResources</code>) for all four stacks of both applications.</p>
      <Status error={error} loading={loading} />
      {data && (
        <>
          <div className="stats">
            <div><strong>{data.totals.resources}</strong><span>resources</span></div>
            <div><strong>{data.totals.distinctResourceTypes}</strong><span>resource types</span></div>
            <div><strong>{data.totals.distinctServices}</strong><span>AWS services</span></div>
            <div><strong>{data.stacks.length}</strong><span>stacks</span></div>
          </div>
          <div className="card"><h2>Stacks</h2>
            <div className="table-wrap"><table><thead><tr><th>Stack</th><th>Application</th><th>Region</th><th>Status</th><th>Resources</th><th>Types</th><th>Last updated</th></tr></thead>
              <tbody>{data.stacks.map((s) => <tr key={s.stack}><td><code>{s.stack}</code></td><td>{s.app}</td><td>{s.region}</td><td>{s.status}</td><td>{s.resourceCount}</td><td>{s.resourceTypes}</td><td>{s.lastUpdated ? new Date(s.lastUpdated).toLocaleString() : ''}</td></tr>)}</tbody></table></div>
          </div>
          <div className="card"><h2>Resources by type</h2>
            <div className="table-wrap"><table><thead><tr><th>CloudFormation type</th><th>Count</th></tr></thead>
              <tbody>{Object.entries(data.totals.byType).map(([t, n]) => <tr key={t}><td><code>{t}</code></td><td>{n}</td></tr>)}</tbody></table></div>
            <p className="muted small">Services: {data.totals.services.join(', ')}</p>
          </div>
        </>
      )}
    </div>
  );
}

export function Logs({ api }: { api: Api }) {
  const [sources, setSources] = useState<string[]>([]);
  const [source, setSource] = useState('advisor-worker');
  const [minutes, setMinutes] = useState(60);
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState({ source, minutes, filter });
  useEffect(() => { api.get<{ logSources: string[] }>('/sources').then((r) => setSources(r.logSources)).catch(() => undefined); }, [api]);
  const { data, error, loading, reload } = useLoad(
    () => api.get<{ events: { time: string; message: string }[]; logGroup: string }>(`/logs?source=${encodeURIComponent(applied.source)}&minutes=${applied.minutes}&limit=50${applied.filter ? `&filter=${encodeURIComponent(applied.filter)}` : ''}`),
    [applied],
  );
  return (
    <div className="stack-gap">
      <h1>CloudWatch logs</h1>
      <form className="card filters" onSubmit={(e) => { e.preventDefault(); setApplied({ source, minutes, filter }); }}>
        <div><label htmlFor="src">Source</label><select id="src" value={source} onChange={(e) => setSource(e.target.value)}>{(sources.length ? sources : [source]).map((s) => <option key={s}>{s}</option>)}</select></div>
        <div><label htmlFor="min">Window</label><select id="min" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{[15, 60, 360, 1440, 10080].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} d`}</option>)}</select></div>
        <div><label htmlFor="flt">Search term</label><input id="flt" value={filter} maxLength={60} pattern="[\w .:-]*" placeholder="e.g. ERROR, guardrail" onChange={(e) => setFilter(e.target.value)} /></div>
        <div className="align-end"><button className="btn primary">Search</button> <button type="button" className="btn ghost" onClick={() => void reload()}>Refresh</button></div>
      </form>
      <Status error={error} loading={loading} />
      {data && (
        <div className="card">
          <p className="muted small">Log group <code>{data.logGroup}</code> · {data.events.length} newest events · emails, keys, tokens and IP addresses are masked.</p>
          {data.events.length === 0 ? <p>No events in this window.</p> : (
            <ul className="log-list">{data.events.map((e, i) => <li key={i}><time>{e.time.replace('T', ' ').slice(0, 19)}</time><pre>{pretty(e.message)}</pre></li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}
export const pretty = (m: string) => { try { return JSON.stringify(JSON.parse(m), null, 2); } catch { return m; } };

interface RRec { ts: string; app: string; modelId: string; promptVersion: string; attempt: number; thinkingEnabled: boolean; stopReason?: string; guardrailAction?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number; toolCalls?: string[]; reasoning?: string; correlationId: string; subjectId?: string; note?: string }
export function Reasoning({ api }: { api: Api }) {
  const [app, setApp] = useState('all');
  const [hours, setHours] = useState(24);
  const { data, error, loading, reload } = useLoad(() => api.get<{ records: RRec[]; totalFound: number }>(`/reasoning?app=${app}&hours=${hours}&limit=25`), [app, hours]);
  return (
    <div className="stack-gap">
      <h1>LLM reasoning logs</h1>
      <p className="muted">One structured record per model invocation, written by the Advisor worker and the chatbot. It holds the model's extended-thinking reasoning and invocation metadata. By design it never holds the complete prompt or the generated report.</p>
      <div className="card filters">
        <div><label htmlFor="app">Application</label><select id="app" value={app} onChange={(e) => setApp(e.target.value)}><option value="all">Both</option><option value="advisor">Secure SDLC Advisor</option><option value="insights">Class Insights chatbot</option></select></div>
        <div><label htmlFor="h">Window</label><select id="h" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 6, 24, 72, 168].map((h) => <option key={h} value={h}>{h} h</option>)}</select></div>
        <div className="align-end"><button className="btn ghost" onClick={() => void reload()}>Refresh</button></div>
      </div>
      <Status error={error} loading={loading} />
      {data && (data.records.length === 0 ? <p className="card">No reasoning records in this window. Run an assessment or ask the chatbot a question.</p> : (
        <ul className="cards-1">{data.records.map((r, i) => (
          <li key={i} className="card">
            <div className="row-between"><strong>{r.app}</strong><time className="muted small">{new Date(r.ts).toLocaleString()}</time></div>
            <p className="small kv">
              <span>model <code>{r.modelId}</code></span><span>prompt v<code>{r.promptVersion}</code></span><span>attempt {r.attempt}</span>
              <span>thinking {r.thinkingEnabled ? 'on' : 'off'}</span><span>stop <code>{r.stopReason}</code></span><span>guardrail {r.guardrailAction}</span>
              <span>{r.inputTokens} in / {r.outputTokens} out tokens</span><span>{r.latencyMs} ms</span>
              {!!r.toolCalls?.length && <span>tools: {r.toolCalls.join(', ')}</span>}<span>correlation <code>{r.correlationId}</code></span>
            </p>
            {r.note && <p className="alert info small">{r.note}</p>}
            {r.reasoning ? <details className="disclosure"><summary>Reasoning ({r.reasoning.length} chars)</summary><pre className="reasoning">{r.reasoning}</pre></details> : <p className="muted small">No reasoning text (thinking disabled for this call).</p>}
          </li>
        ))}</ul>
      ))}
    </div>
  );
}

interface Met { metrics: { name: string; label: string; value: number }[]; alarms: { name: string; state: string; metric: string; threshold: number }[] }
export function Metrics({ api }: { api: Api }) {
  const [hours, setHours] = useState(24);
  const { data, error, loading, reload } = useLoad(() => api.get<Met>(`/metrics?hours=${hours}`), [hours]);
  return (
    <div className="stack-gap">
      <div className="row-between"><h1>Metrics &amp; alarms</h1>
        <div className="inline"><label htmlFor="mh" className="visually-hidden">Window</label><select id="mh" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 6, 24, 72, 168].map((h) => <option key={h} value={h}>last {h} h</option>)}</select> <button className="btn ghost" onClick={() => void reload()}>Refresh</button></div>
      </div>
      <Status error={error} loading={loading} />
      {data && (
        <>
          <div className="stats wide">{data.metrics.map((m) => <div key={m.name}><strong>{m.value.toLocaleString()}</strong><span>{m.label}</span></div>)}</div>
          <div className="card"><h2>Alarms</h2>
            <div className="table-wrap"><table><thead><tr><th>Alarm</th><th>State</th><th>Metric</th><th>Threshold</th></tr></thead>
              <tbody>{data.alarms.map((a) => <tr key={a.name}><td><code>{a.name}</code></td><td><span className={`badge state-${a.state.toLowerCase()}`}>{a.state}</span></td><td>{a.metric}</td><td>{a.threshold}</td></tr>)}</tbody></table></div>
          </div>
        </>
      )}
    </div>
  );
}
