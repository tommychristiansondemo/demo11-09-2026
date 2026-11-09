import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeDeep } from '../src/lib/sanitize';
import { extractReasoning, promptVersion } from '../src/lib/reasoning';
import { queryLogs, type ToolConfig } from '../src/lib/tools';

process.env.TABLE_NAME = 't';
const cfg: ToolConfig = { logGroups: { 'advisor-worker': '/sdlc-advisor/worker' }, stacks: [], knowledgeBucket: 'b', knowledgeKey: 'k', alarmPrefixes: [], functions: {}, apis: {} };

describe('sanitize', () => {
  it('masks IPs, emails, keys and origin-verify headers', () => {
    const s = sanitizeText('ip 203.0.113.45 user a.b@example.com key AKIAABCDEFGHIJKLMNOP "x-origin-verify":"abcdef123456" v6 2001:db8:85a3:0:0:8a2e:370:7334');
    expect(s).toContain('203.0.x.x');
    expect(s).not.toContain('a.b@example.com');
    expect(s).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(s).not.toContain('abcdef123456');
    expect(s).not.toContain('8a2e:370:7334');
  });
  it('redacts secret-named keys but keeps token counts', () => {
    const out = sanitizeDeep({ inputTokens: 10, outputTokens: 5, password: 'p', secretValue: 's', nested: { apiKey: 'k', Authorization: 'Bearer x' } }) as any;
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(5);
    expect(out.password).toBe('[REDACTED]');
    expect(out.secretValue).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.Authorization).toBe('[REDACTED]');
  });
  it('truncates long text', () => { expect(sanitizeText('x'.repeat(5000), 100)).toMatch(/truncated/); });
});

describe('chat input validation', async () => {
  const { parseChat, fromCloudFront } = await import('../src/api');
  it('accepts a question with alternating history', () => {
    const r = parseChat({ question: 'How many resources?', history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }] });
    expect(Array.isArray(r)).toBe(false);
  });
  it('rejects bad shapes', () => {
    expect(parseChat({ question: 'x' })).toEqual(expect.arrayContaining([expect.stringMatching(/question/)]));
    expect(parseChat({ question: 'ok?', history: [{ role: 'assistant', text: 'x' }] })).not.toHaveProperty('question');
    expect(parseChat({ question: 'ok?', extra: 1 })).toEqual(expect.arrayContaining([expect.stringMatching(/Unexpected/)]));
    expect(parseChat({ question: 'ok?', history: [{ role: 'system', text: 'x' }, { role: 'assistant', text: 'y' }] })).toEqual(expect.any(Array));
  });
  it('redacts secrets in the question', () => {
    const r = parseChat({ question: 'is password=hunter22 safe?' }) as any;
    expect(r.question).not.toContain('hunter22');
  });
  it('checks the origin header in constant time', () => {
    expect(fromCloudFront('abc', 'abc')).toBe(true);
    expect(fromCloudFront('abd', 'abc')).toBe(false);
    expect(fromCloudFront(undefined, '')).toBe(false);
  });
});

describe('tools', () => {
  it('rejects log sources outside the allow-list without calling AWS', async () => {
    const r = await queryLogs(cfg, { source: '/aws/lambda/other-app' });
    expect(r).toHaveProperty('error');
  });
  it('bounds tool output', async () => {
    const { boundJson } = await import('../src/chat');
    expect(boundJson({ a: 'x'.repeat(100) }, 50)).toMatchObject({ truncated: true });
    expect(boundJson({ a: 1 }, 50)).toEqual({ a: 1 });
  });
  it('extracts reasoning text and hashes prompts', () => {
    expect(extractReasoning([{ reasoningContent: { reasoningText: { text: 'think' } } }, { text: 'x' }])).toBe('think');
    expect(promptVersion('a')).toHaveLength(12);
  });
});
