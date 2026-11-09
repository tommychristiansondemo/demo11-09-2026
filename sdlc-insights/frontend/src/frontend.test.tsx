import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Md } from './Md';
import { buildHistory, SUGGESTIONS } from './Chat';
import { pretty } from './Pages';

describe('markdown rendering', () => {
  it('does not render raw HTML from model output', () => {
    const { container } = render(<Md>{'Hello <img src=x onerror=alert(1)> **bold** <script>alert(1)</script>'}</Md>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });
  it('renders GFM tables and safe links', () => {
    const { container } = render(<Md>{'| a | b |\n|---|---|\n| 1 | 2 |\n\n[x](https://example.com)'}</Md>);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('chat history', () => {
  it('alternates user/assistant and only includes completed answers', () => {
    const h = buildHistory([
      { question: 'q1', job: { messageId: '1', status: 'COMPLETE', answer: 'a1' } },
      { question: 'q2', job: { messageId: '2', status: 'FAILED' } },
      { question: 'q3', job: { messageId: '3', status: 'COMPLETE', answer: 'a3' } },
    ]);
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h[3].text).toBe('a3');
  });
  it('has suggested questions', () => { expect(SUGGESTIONS.length).toBeGreaterThan(5); });
  it('pretty-prints JSON log lines', () => { expect(pretty('{"a":1}')).toContain('\n'); expect(pretty('plain')).toBe('plain'); });
});
