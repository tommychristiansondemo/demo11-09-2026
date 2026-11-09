import { type AppConfig, type Session, refresh } from './auth';

export class ApiFailure extends Error { constructor(public status: number, message: string, public correlationId?: string) { super(message); } }

export class Api {
  constructor(private cfg: AppConfig, private getSession: () => Session | null, private setSession: (s: Session | null) => void) {}
  private async token() {
    let s = this.getSession();
    if (!s) throw new ApiFailure(401, 'Please sign in.');
    if (s.expiresAt - Date.now() < 60_000) {
      try { s = await refresh(this.cfg, s); this.setSession(s); } catch { this.setSession(null); throw new ApiFailure(401, 'Session expired. Please sign in again.'); }
    }
    return s.idToken;
  }
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { Authorization: await this.token(), 'Content-Type': 'application/json', 'X-Correlation-Id': crypto.randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) this.setSession(null);
      throw new ApiFailure(res.status, data?.error?.message ?? (res.status === 403 ? 'Blocked by the web application firewall.' : 'Request failed.'), data?.error?.correlationId);
    }
    return data as T;
  }
  get = <T,>(path: string) => this.call<T>('GET', path);
  post = <T,>(path: string, body: unknown) => this.call<T>('POST', path, body);
}

export const describeError = (e: unknown) => (e instanceof ApiFailure ? `${e.message}${e.correlationId ? ` (ref ${e.correlationId})` : ''}` : 'Network error.');
