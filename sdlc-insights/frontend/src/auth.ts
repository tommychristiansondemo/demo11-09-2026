// Minimal Amazon Cognito client using the public user-pool API (no SDK needed).
export interface AppConfig { region: string; userPoolId: string; userPoolClientId: string; modelId: string; advisorUrl: string }
export interface Session { username: string; idToken: string; refreshToken: string; expiresAt: number }

const KEY = 'sdlc-insights-session';

async function cognito<T>(cfg: AppConfig, target: string, body: unknown): Promise<T> {
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(data.__type ?? '').split('#').pop();
    throw new Error(friendly(type, data.message));
  }
  return data as T;
}

function friendly(type: string | undefined, message: string | undefined): string {
  switch (type) {
    case 'UsernameExistsException': return 'That username is taken. Pick another one; you can create as many test accounts as you like.';
    case 'NotAuthorizedException': return 'Incorrect username or password.';
    case 'InvalidPasswordException': return 'Password must be at least 6 characters.';
    case 'InvalidParameterException': return message?.includes('username') ? 'Username may contain letters, numbers and . _ - @ only.' : (message ?? 'Invalid input.');
    case 'TooManyRequestsException': return 'Too many attempts. Wait a moment and try again.';
    default: return message ?? 'Authentication failed.';
  }
}

interface AuthResult { AuthenticationResult: { IdToken: string; RefreshToken?: string; ExpiresIn: number } }

export async function signUp(cfg: AppConfig, username: string, password: string) {
  await cognito(cfg, 'SignUp', { ClientId: cfg.userPoolClientId, Username: username, Password: password });
}

export async function signIn(cfg: AppConfig, username: string, password: string): Promise<Session> {
  const r = await cognito<AuthResult>(cfg, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: cfg.userPoolClientId, AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  const s: Session = { username, idToken: r.AuthenticationResult.IdToken, refreshToken: r.AuthenticationResult.RefreshToken ?? '', expiresAt: Date.now() + r.AuthenticationResult.ExpiresIn * 1000 };
  save(s);
  return s;
}

export async function refresh(cfg: AppConfig, s: Session): Promise<Session> {
  const r = await cognito<AuthResult>(cfg, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: cfg.userPoolClientId, AuthParameters: { REFRESH_TOKEN: s.refreshToken },
  });
  const n = { ...s, idToken: r.AuthenticationResult.IdToken, expiresAt: Date.now() + r.AuthenticationResult.ExpiresIn * 1000 };
  save(n);
  return n;
}

export async function signOut(cfg: AppConfig, s: Session | null) {
  clear();
  if (s?.refreshToken) await cognito(cfg, 'RevokeToken', { ClientId: cfg.userPoolClientId, Token: s.refreshToken }).catch(() => undefined);
}

function save(s: Session) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }
function clear() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }
export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.idToken && s.refreshToken ? s : null;
  } catch { return null; }
}
