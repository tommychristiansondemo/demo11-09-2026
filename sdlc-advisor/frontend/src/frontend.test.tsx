import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { clientIssues, validateFile } from './AssessmentForm';
import { slug, ResultView } from './ResultView';
import { Notice } from './App';
import { EXAMPLES } from './examples';
import { COMPONENTS, DATA_CLASSIFICATIONS, EXPOSURES, LIMITS } from '../../services/src/lib/catalog';

describe('form validation', () => {
  it('requires synthetic-data confirmation', () => {
    const ex = EXAMPLES[0];
    const base = { ...ex, syntheticConfirmed: false };
    expect(clientIssues(base)).toEqual(['Confirm that you are submitting synthetic or nonconfidential information.']);
    expect(clientIssues({ ...base, syntheticConfirmed: true })).toEqual([]);
  });
  it('accepts only small .txt/.md files', () => {
    expect(validateFile({ name: 'a.md', size: 100, type: 'text/markdown' })).toBeNull();
    expect(validateFile({ name: 'a.pdf', size: 100, type: 'application/pdf' })).toMatch(/Only/);
    expect(validateFile({ name: 'a.txt', size: 99_999, type: 'text/plain' })).toMatch(/larger/);
    expect(validateFile({ name: 'evil.txt', size: 10, type: 'application/x-msdownload' })).toMatch(/plain-text/);
  });
});

describe('examples', () => {
  it('reference only catalog values and fit the limits', () => {
    const c = new Set<string>(COMPONENTS.map((x) => x.id));
    const d = new Set<string>(DATA_CLASSIFICATIONS.map((x) => x.id));
    const e = new Set<string>(EXPOSURES.map((x) => x.id));
    for (const ex of EXAMPLES) {
      expect(ex.components.every((x) => c.has(x))).toBe(true);
      expect(ex.dataClassifications.every((x) => d.has(x))).toBe(true);
      expect(e.has(ex.exposure)).toBe(true);
      expect(ex.description.length).toBeLessThanOrEqual(LIMITS.descriptionMax);
      expect(ex.description.length).toBeGreaterThanOrEqual(LIMITS.descriptionMin);
    }
  });
});

describe('rendering', () => {
  it('shows the confidentiality notice', () => {
    render(<Notice />);
    expect(screen.getByRole('note').textContent).toMatch(/Do not enter Gilead confidential/);
  });
  it('renders model output as text, never as HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const detail = {
      assessmentId: 'x', title: evil, status: 'COMPLETE', createdAt: new Date().toISOString(), expiresAt: '', redactions: 0,
      input: { title: evil, description: '', components: [], dataClassifications: [], exposure: 'internal' },
      result: { architectureSummary: evil, overallRisk: 'High', threats: [], risks: [], controls: [], checklist: [], userStories: [], assumptions: [] },
    } as never;
    const { container } = render(<ResultView detail={detail} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(evil);
  });
  it('slugs filenames safely', () => {
    expect(slug('../../etc/passwd <x>')).toBe('etc-passwd-x');
  });
});
