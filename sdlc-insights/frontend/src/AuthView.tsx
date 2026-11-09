import { useState, type FormEvent } from 'react';
import { type AppConfig, type Session, signIn, signUp } from './auth';

export function AuthView({ cfg, onSignedIn }: { cfg: AppConfig; onSignedIn: (s: Session) => void }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (!/^[\w.@-]{3,64}$/.test(username)) return setError('Username must be 3-64 characters: letters, numbers, . _ - @');
    if (password.length < 6) return setError('Password must be at least 6 characters.');
    setBusy(true);
    try { if (mode === 'register') await signUp(cfg, username, password); onSignedIn(await signIn(cfg, username, password)); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="auth-wrap">
      <section className="card auth">
        <h1>{mode === 'signin' ? 'Sign in' : 'Create a test account'}</h1>
        <p className="muted">Use the same account you created in the <a href={cfg.advisorUrl}>Secure SDLC Advisor</a>, or register a new one. No email or verification needed.</p>
        <div className="tabs" role="tablist" aria-label="Authentication mode">
          <button role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'tab active' : 'tab'} onClick={() => setMode('signin')}>Sign in</button>
          <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>Register</button>
        </div>
        <form onSubmit={submit} noValidate>
          <label htmlFor="u">Username</label>
          <input id="u" autoComplete="username" value={username} maxLength={64} onChange={(e) => setUsername(e.target.value.trim())} />
          <label htmlFor="p">Password <span className="muted">(minimum 6 characters)</span></label>
          <input id="p" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="alert error" role="alert">{error}</p>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Register and sign in'}</button>
        </form>
      </section>
      <section className="card about">
        <h2>What is Class Insights?</h2>
        <p>A companion app that explains <strong>everything deployed for this class</strong>: the architecture, every AWS resource, the LLMs and prompts, security controls, costs, and the deployment history.</p>
        <ul>
          <li>Ask the <strong>chatbot</strong> (Amazon Bedrock) anything about the design.</li>
          <li>Browse the live <strong>resource inventory</strong>, <strong>CloudWatch logs</strong>, <strong>metrics</strong> and <strong>LLM reasoning logs</strong>.</li>
          <li>Read the full <strong>project knowledge</strong> document the chatbot uses.</li>
        </ul>
        <p className="muted small">Secrets and API keys are never exposed: the backend has no permission to read them, and all output is redacted.</p>
      </section>
    </div>
  );
}
