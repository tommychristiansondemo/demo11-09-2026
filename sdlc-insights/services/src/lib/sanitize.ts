import { redact } from './redact';

// Everything returned to students passes through here: secret/PII redaction, IPv4/IPv6 masking,
// and removal of any header that could carry the CloudFront origin-verify value.
export function sanitizeText(input: string, max = 2000): string {
  let t = redact(input).text;
  t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, '$1.$2.x.x');
  t = t.replace(/\b([0-9a-f]{1,4}:){3}[0-9a-f:]{2,}\b/gi, (m) => m.split(':').slice(0, 3).join(':') + ':x:x');
  t = t.replace(/(x-origin-verify["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[REDACTED]');
  return t.length > max ? t.slice(0, max) + '…[truncated]' : t;
}

export function sanitizeDeep<T>(value: T, max = 2000): T {
  if (typeof value === 'string') return sanitizeText(value, max) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, max)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(secret\w*|password|passwd|token|access_?token|id_?token|refresh_?token|api_?key|authorization|x-origin-verify|origin_?verify|credentials?)$/i.test(k)) { out[k] = '[REDACTED]'; continue; }
      out[k] = sanitizeDeep(v, max);
    }
    return out as T;
  }
  return value;
}
