import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AppConfig, type Session, loadSession, signOut } from './auth';
import { Api, ApiFailure, type Detail, type Summary } from './api';
import { AuthView } from './AuthView';
import { AssessmentForm } from './AssessmentForm';
import { ResultView } from './ResultView';
import { History } from './History';

export function Notice() {
  return (
    <div className="notice" role="note" aria-label="Data handling notice">
      <strong>Training demo — synthetic data only.</strong>{' '}
      Do not enter Gilead confidential, personal, patient, clinical, regulated, proprietary, or production information.
      Use the built-in examples or invent a fictional system. Output is AI-generated and must be reviewed by a qualified security professional.
    </div>
  );
}

export function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [cfgError, setCfgError] = useState('');
  const [session, setSessionState] = useState<Session | null>(() => loadSession());
  const sessionRef = useRef(session);
  const setSession = useCallback((s: Session | null) => { sessionRef.current = s; setSessionState(s); }, []);

  const [history, setHistory] = useState<Summary[]>([]);
  const [current, setCurrent] = useState<Detail | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setCfg)
      .catch(() => setCfgError('Could not load application configuration.'));
  }, []);

  const api = useMemo(() => (cfg ? new Api(cfg, () => sessionRef.current, setSession) : null), [cfg, setSession]);

  const describe = (e: unknown) => (e instanceof ApiFailure ? `${e.detail.message}${e.detail.correlationId ? ` (ref ${e.detail.correlationId})` : ''}` : 'Network error. Please try again.');

  const loadHistory = useCallback(async () => {
    if (!api || !sessionRef.current) return;
    try { setHistory((await api.list()).items); } catch (e) { setError(describe(e)); }
  }, [api]);

  useEffect(() => { if (session) void loadHistory(); }, [session, loadHistory]);

  // Poll the active assessment until it leaves PENDING.
  useEffect(() => {
    if (!api || !activeId) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const d = await api.get(activeId);
        if (cancelled) return;
        setCurrent(d);
        if (d.status === 'PENDING') timer = window.setTimeout(tick, 3000);
        else void loadHistory();
      } catch (e) {
        if (!cancelled) setError(describe(e));
      }
    };
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, activeId, loadHistory]);

  if (cfgError) return <main className="center"><p role="alert">{cfgError}</p></main>;
  if (!cfg || !api) return <main className="center"><p aria-live="polite">Loading…</p></main>;

  const open = (id: string) => { setError(''); setCurrent(null); setActiveId(id); };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="brand">
          <svg aria-hidden="true" viewBox="0 0 32 32" width="28" height="28"><path d="M16 4l10 4.5v6.5c0 6.6-4.4 11-10 13-5.6-2-10-6.4-10-13V8.5z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" /><path d="M11.5 16l3.2 3.2 5.8-6.7" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>Secure SDLC Advisor</span>
        </div>
        <div className="user">
          {cfg.insightsUrl && <a className="btn ghost" href={cfg.insightsUrl}>Class Insights &amp; chatbot ↗</a>}
        {session && (
          <>
            <span className="muted">Signed in as <strong>{session.username}</strong></span>
            <button className="btn ghost" onClick={() => { void signOut(cfg, session); setSession(null); setCurrent(null); setActiveId(null); setHistory([]); }}>Sign out</button>
          </>
        )}
        </div>
      </header>
      <Notice />
      <main id="main" tabIndex={-1}>
        {!session ? (
          <AuthView cfg={cfg} onSignedIn={setSession} />
        ) : (
          <div className="layout">
            <aside className="sidebar" aria-label="Assessment history">
              <button className="btn primary block" onClick={() => { setActiveId(null); setCurrent(null); setError(''); }}>+ New assessment</button>
              <History items={history} activeId={activeId} ttlDays={cfg.historyTtlDays} onOpen={open}
                onDelete={async (id) => {
                  try { await api.remove(id); if (id === activeId) { setActiveId(null); setCurrent(null); } await loadHistory(); } catch (e) { setError(describe(e)); }
                }} />
            </aside>
            <section className="content">
              {error && <div className="alert error" role="alert">{error} <button className="link" onClick={() => setError('')}>Dismiss</button></div>}
              {activeId ? (
                <ResultView detail={current} />
              ) : (
                <AssessmentForm
                  modelId={cfg.modelId}
                  onSubmit={async (input) => {
                    setError('');
                    try {
                      const r = await api.create(input);
                      await loadHistory();
                      open(r.assessmentId);
                      return null;
                    } catch (e) {
                      if (e instanceof ApiFailure && e.detail.issues) return e.detail.issues;
                      setError(describe(e));
                      return null;
                    }
                  }}
                />
              )}
            </section>
          </div>
        )}
      </main>
      <footer className="footer">
        Vendor-neutral training demonstration. Not an official tool or endorsement of any organisation. AI output may be incomplete or incorrect.
      </footer>
    </>
  );
}
