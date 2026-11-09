import type { AppConfig, Session } from './auth';
import { refresh } from './auth';

export interface ApiError { code: string; message: string; correlationId?: string; issues?: string[] }
export class ApiFailure extends Error { constructor(public status: number, public detail: ApiError) { super(detail.message); } }

export interface Summary { assessmentId: string; title: string; status: 'PENDING' | 'COMPLETE' | 'FAILED' | 'BLOCKED'; createdAt: string; overallRisk?: string; expiresAt: string }
type Sev = 'Critical' | 'High' | 'Medium' | 'Low';
export interface Result {
  architectureSummary: string; overallRisk: Sev;
  threats: { id: string; stride: string; component: string; threat: string; likelihood: string; impact: string; severity: Sev; mitigation: string }[];
  risks: { category: string; title: string; description: string; severity: Sev }[];
  controls: { service: string; control: string; rationale: string; addresses: string[] }[];
  checklist: { priority: 'P0' | 'P1' | 'P2'; item: string; owner: string; verification: string }[];
  userStories: { title: string; story: string; acceptanceCriteria: string[] }[];
  assumptions: string[];
}
export interface Detail extends Summary {
  input: { title: string; description: string; components: string[]; dataClassifications: string[]; exposure: string };
  redactions: number; result?: Result; errorMessage?: string; modelId?: string; durationMs?: number; markdown?: string;
}

const newCorrelationId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export class Api {
  constructor(private cfg: AppConfig, private getSession: () => Session | null, private setSession: (s: Session | null) => void) {}

  private async token(): Promise<string> {
    let s = this.getSession();
    if (!s) throw new ApiFailure(401, { code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    if (s.expiresAt - Date.now() < 60_000) {
      try { s = await refresh(this.cfg, s); this.setSession(s); } catch { this.setSession(null); throw new ApiFailure(401, { code: 'UNAUTHENTICATED', message: 'Your session expired. Please sign in again.' }); }
    }
    return s.idToken;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { Authorization: await this.token(), 'Content-Type': 'application/json', 'X-Correlation-Id': newCorrelationId() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) this.setSession(null);
      throw new ApiFailure(res.status, data.error ?? { code: String(res.status), message: res.status === 403 ? 'The request was blocked by the web application firewall or access policy.' : 'Request failed.' });
    }
    return data as T;
  }

  create = (input: unknown) => this.call<{ assessmentId: string; status: string; redactions: number }>('POST', '/assessments', input);
  list = () => this.call<{ items: Summary[] }>('GET', '/assessments');
  get = (id: string) => this.call<Detail>('GET', `/assessments/${encodeURIComponent(id)}`);
  remove = (id: string) => this.call<{ deleted: boolean }>('DELETE', `/assessments/${encodeURIComponent(id)}`);
}
