import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { COMPONENTS, DATA_CLASSIFICATIONS, EXPOSURES, LIMITS } from '../../services/src/lib/catalog';
import { EXAMPLES } from './examples';

export interface FormInput { title: string; description: string; components: string[]; dataClassifications: string[]; exposure: string; syntheticConfirmed: boolean }

const ALLOWED_EXT = ['.txt', '.md'];
const MAX_FILE_BYTES = 12_000;

export function validateFile(file: { name: string; size: number; type: string }): string | null {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXT.some((e) => name.endsWith(e))) return 'Only .txt or .md files are supported.';
  if (file.type && !['text/plain', 'text/markdown', 'text/x-markdown'].includes(file.type)) return 'Only plain-text files are supported.';
  if (file.size > MAX_FILE_BYTES) return `File is larger than ${MAX_FILE_BYTES / 1000} KB.`;
  return null;
}

export function clientIssues(f: FormInput): string[] {
  const issues: string[] = [];
  if (f.title.trim().length < LIMITS.titleMin) issues.push('Enter an application title.');
  if (f.description.trim().length < LIMITS.descriptionMin) issues.push(`Description must be at least ${LIMITS.descriptionMin} characters.`);
  if (f.description.length > LIMITS.descriptionMax) issues.push(`Description must be at most ${LIMITS.descriptionMax} characters.`);
  if (f.components.length === 0) issues.push('Select at least one architecture component.');
  if (f.dataClassifications.length === 0) issues.push('Select at least one data classification.');
  if (!f.exposure) issues.push('Select how the application is exposed.');
  if (!f.syntheticConfirmed) issues.push('Confirm that you are submitting synthetic or nonconfidential information.');
  return issues;
}

const groups = [...new Set(COMPONENTS.map((c) => c.group))];
const empty: FormInput = { title: '', description: '', components: [], dataClassifications: [], exposure: '', syntheticConfirmed: false };

export function AssessmentForm({ onSubmit, modelId }: { onSubmit: (f: FormInput) => Promise<string[] | null>; modelId: string }) {
  const [form, setForm] = useState<FormInput>(empty);
  const [issues, setIssues] = useState<string[]>([]);
  const [fileMsg, setFileMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const issuesRef = useRef<HTMLDivElement>(null);

  const toggle = (key: 'components' | 'dataClassifications', id: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] }));

  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setForm({ title: ex.title, description: ex.description, components: ex.components, dataClassifications: ex.dataClassifications, exposure: ex.exposure, syntheticConfirmed: false });
    setIssues([]);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = validateFile(file);
    if (problem) { setFileMsg(problem); return; }
    const text = await file.text();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008]/.test(text)) { setFileMsg('The file does not look like plain text.'); return; }
    const merged = (form.description ? form.description + '\n\n' : '') + text;
    setForm((f) => ({ ...f, description: merged.slice(0, LIMITS.descriptionMax) }));
    setFileMsg(merged.length > LIMITS.descriptionMax ? `Imported and truncated to ${LIMITS.descriptionMax} characters.` : `Imported ${file.name}. Treated as data only.`);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local = clientIssues(form);
    setIssues(local);
    if (local.length) { issuesRef.current?.focus(); return; }
    setBusy(true);
    const server = await onSubmit(form);
    setBusy(false);
    if (server) { setIssues(server); issuesRef.current?.focus(); }
  };

  const remaining = LIMITS.descriptionMax - form.description.length;

  return (
    <form className="card form" onSubmit={submit} noValidate aria-labelledby="form-title">
      <div className="form-head">
        <h1 id="form-title">New pre-deployment assessment</h1>
        <div className="examples">
          <label htmlFor="example">Load a synthetic example</label>
          <select id="example" value="" onChange={(e) => loadExample(e.target.value)}>
            <option value="">Choose an example…</option>
            {EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.title}</option>)}
          </select>
        </div>
      </div>

      <div ref={issuesRef} tabIndex={-1} aria-live="assertive">
        {issues.length > 0 && (
          <div className="alert error" role="alert">
            <strong>Please fix the following:</strong>
            <ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        )}
      </div>

      <label htmlFor="title">Application title</label>
      <input id="title" value={form.title} maxLength={LIMITS.titleMax} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Lab Equipment Booking Portal" />

      <div className="label-row">
        <label htmlFor="description">Application description (synthetic)</label>
        <span className={remaining < 200 ? 'counter warn' : 'counter'} aria-live="polite">{remaining} characters left</span>
      </div>
      <textarea id="description" rows={9} value={form.description} maxLength={LIMITS.descriptionMax} aria-describedby="desc-help"
        onChange={(e) => setForm({ ...form, description: e.target.value })}
        placeholder="Describe users, data flows, integrations, authentication, data stored, scale and availability needs of a fictional application." />
      <p id="desc-help" className="muted small">
        Likely emails, keys, tokens and passwords are automatically redacted before processing. Optional:{' '}
        <label className="file-label">import a .txt or .md file<input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={onFile} className="visually-hidden" /></label>
        {fileMsg && <span className="file-msg" role="status"> — {fileMsg}</span>}
      </p>

      <fieldset>
        <legend>Architecture components</legend>
        <div className="groups">
          {groups.map((g) => (
            <div key={g} className="group">
              <h3>{g}</h3>
              {COMPONENTS.filter((c) => c.group === g).map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={form.components.includes(c.id)} onChange={() => toggle('components', c.id)} />
                  {c.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      </fieldset>

      <div className="two-col">
        <fieldset>
          <legend>Data classifications (synthetic)</legend>
          {DATA_CLASSIFICATIONS.map((d) => (
            <label key={d.id} className="check">
              <input type="checkbox" checked={form.dataClassifications.includes(d.id)} onChange={() => toggle('dataClassifications', d.id)} />
              {d.label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Exposure</legend>
          {EXPOSURES.map((x) => (
            <label key={x.id} className="check">
              <input type="radio" name="exposure" checked={form.exposure === x.id} onChange={() => setForm({ ...form, exposure: x.id })} />
              {x.label}
            </label>
          ))}
        </fieldset>
      </div>

      <label className="check confirm">
        <input type="checkbox" checked={form.syntheticConfirmed} onChange={(e) => setForm({ ...form, syntheticConfirmed: e.target.checked })} />
        <span>I confirm this submission contains only <strong>synthetic or nonconfidential</strong> information and no confidential, personal, patient, clinical, regulated, proprietary, or production data.</span>
      </label>

      <div className="actions">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Submitting…' : 'Generate assessment'}</button>
        <button type="button" className="btn ghost" onClick={() => { setForm(empty); setIssues([]); setFileMsg(''); }}>Clear</button>
        <span className="muted small">Model: {modelId}. Typical run time 1–2 minutes.</span>
      </div>
    </form>
  );
}
