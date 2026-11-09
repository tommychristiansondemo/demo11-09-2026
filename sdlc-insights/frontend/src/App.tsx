import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AppConfig, type Session, loadSession, signOut } from './auth';
import { Api } from './api';
import { AuthView } from './AuthView';
import { Chat } from './Chat';
import { Knowledge, Inventory, Logs, Reasoning, Metrics } from './Pages';

const TABS = ['Chatbot', 'Project knowledge', 'Resources', 'Logs', 'LLM reasoning', 'Metrics'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [cfgError, setCfgError] = useState(false);
  const [session, setS] = useState<Session | null>(() => loadSession());
  const ref = useRef(session);
  const setSession = useCallback((s: Session | null) => { ref.current = s; setS(s); }, []);
  const [tab, setTab] = useState<Tab>('Chatbot');
  useEffect(() => { fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()).then(setCfg).catch(() => setCfgError(true)); }, []);
  const api = useMemo(() => (cfg ? new Api(cfg, () => ref.current, setSession) : null), [cfg, setSession]);
  if (cfgError) return <main className="center"><p role="alert">Could not load configuration.</p></main>;
  if (!cfg || !api) return <main className="center"><p>Loading…</p></main>;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="brand">
          <svg aria-hidden="true" viewBox="0 0 32 32" width="26" height="26"><circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="2.6" /><path d="M20 20l7 7" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" /></svg>
          <span>Class Insights</span><span className="muted small sub">for the Secure SDLC Advisor demo</span>
        </div>
        <div className="user">
          <a className="btn ghost" href={cfg.advisorUrl}>← Secure SDLC Advisor</a>
          {session && <><span className="muted">Signed in as <strong>{session.username}</strong></span><button className="btn ghost" onClick={() => { void signOut(cfg, session); setSession(null); }}>Sign out</button></>}
        </div>
      </header>
      <div className="notice" role="note">Training demo with synthetic data only. Everything here is read-only. Secrets and API keys are never accessible, and logs are redacted.</div>
      <main id="main" tabIndex={-1}>
        {!session ? <AuthView cfg={cfg} onSignedIn={setSession} /> : (
          <>
            <nav className="tabs main-tabs" role="tablist" aria-label="Sections">
              {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>)}
            </nav>
            <div role="tabpanel">
              {/* Chat stays mounted so a conversation survives tab switches */}
              <div hidden={tab !== 'Chatbot'}><Chat api={api} /></div>
              {tab === 'Project knowledge' && <Knowledge api={api} />}
              {tab === 'Resources' && <Inventory api={api} />}
              {tab === 'Logs' && <Logs api={api} />}
              {tab === 'LLM reasoning' && <Reasoning api={api} />}
              {tab === 'Metrics' && <Metrics api={api} />}
            </div>
          </>
        )}
      </main>
      <footer className="footer">Vendor-neutral training demonstration. Not an official tool of any organisation. Chatbot model: {cfg.modelId}.</footer>
    </>
  );
}
