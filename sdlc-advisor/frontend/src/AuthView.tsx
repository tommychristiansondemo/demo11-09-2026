import { useState, type FormEvent } from 'react';
import { type AppConfig, type Session, signIn, signUp } from './auth';

export function AuthView({ cfg, onSignedIn }: { cfg: AppConfig; onSignedIn: (s: Session) => void }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!/^[\w.@-]{3,64}$/.test(username)) { setError('Username must be 3-64 characters: letters, numbers, . _ - @'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setBusy(true);
    try {
      if (mode === 'register') await signUp(cfg, username, password);
      onSignedIn(await signIn(cfg, username, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <section className="card auth">
        <h1>{mode === 'signin' ? 'Sign in' : 'Create a test account'}</h1>
        <p className="muted">
          {mode === 'signin'
            ? 'Sign in to run AI-assisted pre-deployment security assessments.'
            : 'No email or verification needed. Register as many accounts as you like to test the app (for example student1-a, student1-b).'}
        </p>
        <div className="tabs" role="tablist" aria-label="Authentication mode">
          <button role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'tab active' : 'tab'} onClick={() => { setMode('signin'); setError(''); }}>Sign in</button>
          <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => { setMode('register'); setError(''); }}>Register</button>
        </div>
        <form onSubmit={submit} noValidate>
          <label htmlFor="username">Username</label>
          <input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value.trim())} maxLength={64} required />
          <label htmlFor="password">Password <span className="muted">(minimum 6 characters)</span></label>
          <input id="password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} maxLength={128} required />
          {error && <p className="alert error" role="alert">{error}</p>}
          <button className="btn primary block" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Register and sign in'}</button>
        </form>
      </section>
      <section className="card about">
        <h2>What this demo does</h2>
        <ol>
          <li>Describe a <em>fictional</em> application, or load a built-in synthetic example.</li>
          <li>Select its AWS components, data classifications and exposure.</li>
          <li>Amazon Bedrock generates an architecture summary, STRIDE threat model, risks, recommended AWS controls, a prioritised pre-deployment checklist and security user stories.</li>
          <li>Download the assessment as Markdown.</li>
        </ol>
        <p className="muted">Assessments are stored for a limited time and deleted automatically.</p>
        {cfg.insightsUrl && (
          <div className="insights-callout">
            <h3>How was this built?</h3>
            <p>Explore the architecture, every deployed AWS resource, live logs, LLM reasoning logs, and ask the project chatbot in <a href={cfg.insightsUrl}><strong>Class Insights</strong></a>.</p>
          </div>
        )}
      </section>
    </div>
  );
}
