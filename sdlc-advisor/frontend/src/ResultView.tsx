import { useEffect, useRef, useState } from 'react';
import type { Detail, Result } from './api';
import { COMPONENTS } from '../../services/src/lib/catalog';

const sevClass = (s: string) => `sev sev-${s.toLowerCase()}`;
const SECTIONS = ['Summary', 'Threat model', 'Risks', 'Controls', 'Checklist', 'User stories'] as const;
type Section = (typeof SECTIONS)[number];

export function downloadMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'assessment';

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return <span>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}

export function ResultView({ detail }: { detail: Detail | null }) {
  const [section, setSection] = useState<Section>('Summary');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (detail?.status === 'COMPLETE') headingRef.current?.focus(); }, [detail?.status]);

  if (!detail) return <div className="card"><p aria-live="polite">Loading assessment…</p></div>;

  if (detail.status === 'PENDING') {
    return (
      <div className="card pending" aria-live="polite" aria-busy="true">
        <div className="spinner" aria-hidden="true" />
        <h1>Generating assessment for “{detail.title}”</h1>
        <p>Amazon Bedrock is building the threat model, risks, controls, checklist and user stories. This usually takes 1–2 minutes. Elapsed <Elapsed since={detail.createdAt} />.</p>
        {detail.redactions > 0 && <p className="alert info">{detail.redactions} sensitive-looking value(s) were redacted before processing.</p>}
      </div>
    );
  }

  if (detail.status !== 'COMPLETE' || !detail.result) {
    return (
      <div className="card">
        <h1>{detail.title}</h1>
        <div className="alert error" role="alert">{detail.status === 'BLOCKED' ? 'Blocked by guardrail: ' : 'Assessment failed: '}{detail.errorMessage ?? 'Unknown error.'}</div>
      </div>
    );
  }

  const r: Result = detail.result;
  const counts = { P0: 0, P1: 0, P2: 0 };
  r.checklist.forEach((c) => { counts[c.priority] += 1; });

  return (
    <article className="card result">
      <div className="result-head">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>{detail.title}</h1>
          <p className="muted small">
            Generated {new Date(detail.createdAt).toLocaleString()} · {detail.modelId} · {detail.durationMs ? `${Math.round(detail.durationMs / 1000)}s` : ''}
            {detail.redactions > 0 && ` · ${detail.redactions} value(s) redacted`}
          </p>
        </div>
        <div className="head-actions">
          <span className={sevClass(r.overallRisk)} aria-label={`Overall risk ${r.overallRisk}`}>Overall risk: {r.overallRisk}</span>
          {detail.markdown && <button className="btn primary" onClick={() => downloadMarkdown(`${slug(detail.title)}-assessment.md`, detail.markdown!)}>Download Markdown</button>}
        </div>
      </div>

      <div className="stats">
        <div><strong>{r.threats.length}</strong><span>threats</span></div>
        <div><strong>{r.risks.length}</strong><span>risks</span></div>
        <div><strong>{r.controls.length}</strong><span>controls</span></div>
        <div><strong>{counts.P0}</strong><span>P0 actions</span></div>
        <div><strong>{r.userStories.length}</strong><span>user stories</span></div>
      </div>

      <nav className="tabs" role="tablist" aria-label="Assessment sections">
        {SECTIONS.map((s) => (
          <button key={s} role="tab" id={`tab-${slug(s)}`} aria-selected={section === s} aria-controls="panel" className={section === s ? 'tab active' : 'tab'} onClick={() => setSection(s)}>{s}</button>
        ))}
      </nav>

      <div id="panel" role="tabpanel" aria-labelledby={`tab-${slug(section)}`} className="panel">
        {section === 'Summary' && (
          <>
            <h2>Architecture summary</h2>
            <p className="prose">{r.architectureSummary}</p>
            <h3>Components assessed</h3>
            <ul className="chips">{detail.input.components.map((c) => <li key={c}>{COMPONENTS.find((x) => x.id === c)?.label ?? c}</li>)}</ul>
            {r.assumptions.length > 0 && (<><h3>Assumptions and open questions</h3><ul>{r.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></>)}
          </>
        )}
        {section === 'Threat model' && (
          <>
            <h2>STRIDE threat model</h2>
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">STRIDE threats</caption>
                <thead><tr><th scope="col">ID</th><th scope="col">STRIDE</th><th scope="col">Component</th><th scope="col">Threat</th><th scope="col">L / I</th><th scope="col">Severity</th><th scope="col">Mitigation</th></tr></thead>
                <tbody>
                  {r.threats.map((t) => (
                    <tr key={t.id}><td>{t.id}</td><td>{t.stride}</td><td>{t.component}</td><td>{t.threat}</td><td>{t.likelihood[0]} / {t.impact[0]}</td><td><span className={sevClass(t.severity)}>{t.severity}</span></td><td>{t.mitigation}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {section === 'Risks' && (
          <>
            <h2>Security, privacy, availability and operational risks</h2>
            <ul className="cards">
              {r.risks.map((x, i) => (
                <li key={i} className="mini-card"><div className="mini-head"><span className="pill">{x.category}</span><span className={sevClass(x.severity)}>{x.severity}</span></div><h3>{x.title}</h3><p>{x.description}</p></li>
              ))}
            </ul>
          </>
        )}
        {section === 'Controls' && (
          <>
            <h2>Recommended AWS controls</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Service</th><th scope="col">Control</th><th scope="col">Rationale</th><th scope="col">Addresses</th></tr></thead>
                <tbody>{r.controls.map((c, i) => <tr key={i}><td><strong>{c.service}</strong></td><td>{c.control}</td><td>{c.rationale}</td><td>{c.addresses.join(', ')}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        )}
        {section === 'Checklist' && (
          <>
            <h2>Prioritised pre-deployment checklist</h2>
            <p className="muted small">P0 = must fix before deployment · P1 = before go-live · P2 = soon after. Ticks are local to this page.</p>
            <ul className="checklist">
              {r.checklist.map((c, i) => (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" />
                    <span><span className={`prio prio-${c.priority.toLowerCase()}`}>{c.priority}</span> {c.item}<br /><span className="muted small">Owner: {c.owner} · Verify: {c.verification}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {section === 'User stories' && (
          <>
            <h2>Security user stories and acceptance criteria</h2>
            {r.userStories.map((u, i) => (
              <section key={i} className="story">
                <h3>{u.title}</h3>
                <p className="prose"><em>{u.story}</em></p>
                <ul>{u.acceptanceCriteria.map((a, j) => <li key={j}>{a}</li>)}</ul>
              </section>
            ))}
          </>
        )}
      </div>
    </article>
  );
}
