// Best-effort redaction of sensitive-looking strings BEFORE any processing,
// storage or model invocation. This is defence-in-depth: users are told to submit
// synthetic data only, and a Bedrock guardrail applies a second PII filter.

interface Rule {
  name: string;
  re: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'aws-access-key', re: /\b(AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, replacement: '[REDACTED_AWS_KEY_ID]' },
  { name: 'aws-secret-key', re: /\b(aws_?secret_?access_?key|secret_?key)\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi, replacement: '[REDACTED_AWS_SECRET]' },
  { name: 'github-token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'api-key-generic', re: /\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replacement: 'Bearer [REDACTED_TOKEN]' },
  { name: 'conn-string-password', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, replacement: '$1:[REDACTED]@' },
  { name: 'password-assignment', re: /\b(password|passwd|pwd|secret|api[_-]?key|token|client[_-]?secret)\b(\s*[:=]\s*)["']?[^\s"',;]{4,}["']?/gi, replacement: '$1$2[REDACTED]' },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
  { name: 'us-ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_ID]' },
  { name: 'credit-card', re: /\b(?:\d[ -]?){13,16}\b/g, replacement: '[REDACTED_NUMBER]' },
  { name: 'phone', re: /(?<!\w)(\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, replacement: '[REDACTED_PHONE]' },
];

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
  total: number;
}

export function redact(input: string): RedactionResult {
  let text = input;
  const counts: Record<string, number> = {};
  let total = 0;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      total += 1;
      // Re-run replacement so $1/$2 back-references work.
      const match = args[0] as string;
      return match.replace(new RegExp(rule.re.source, rule.re.flags.replace('g', '')), rule.replacement);
    });
  }
  return { text, counts, total };
}
