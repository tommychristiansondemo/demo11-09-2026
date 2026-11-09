// Defensive normalisation of model output. The model is asked to follow a JSON schema,
// but we never trust it: enums are enforced, strings are trimmed/truncated and arrays capped.

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';
export interface Threat { id: string; stride: string; component: string; threat: string; likelihood: string; impact: string; severity: Severity; mitigation: string }
export interface Risk { category: string; title: string; description: string; severity: Severity }
export interface Control { service: string; control: string; rationale: string; addresses: string[] }
export interface ChecklistItem { priority: 'P0' | 'P1' | 'P2'; item: string; owner: string; verification: string }
export interface UserStory { title: string; story: string; acceptanceCriteria: string[] }
export interface AssessmentResult {
  architectureSummary: string;
  overallRisk: Severity;
  threats: Threat[];
  risks: Risk[];
  controls: Control[];
  checklist: ChecklistItem[];
  userStories: UserStory[];
  assumptions: string[];
}

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
const STRIDE = ['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'Denial of Service', 'Elevation of Privilege'];
const HML = ['High', 'Medium', 'Low'];
const CATEGORIES = ['Security', 'Privacy', 'Availability', 'Operational'];
const PRIORITIES = ['P0', 'P1', 'P2'] as const;

const s = (v: unknown, max = 800): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class ResultShapeError extends Error {}

export function normaliseResult(raw: unknown): AssessmentResult {
  const r = obj(raw);
  const result: AssessmentResult = {
    architectureSummary: s(r.architectureSummary, 2000),
    overallRisk: pick(r.overallRisk, SEVERITIES, 'Medium'),
    threats: arr(r.threats, 20).map(obj).map((t, i) => ({
      id: s(t.id, 8) || `T${i + 1}`,
      stride: pick(t.stride, STRIDE, 'Tampering'),
      component: s(t.component, 160),
      threat: s(t.threat),
      likelihood: pick(t.likelihood, HML, 'Medium'),
      impact: pick(t.impact, HML, 'Medium'),
      severity: pick(t.severity, SEVERITIES, 'Medium'),
      mitigation: s(t.mitigation),
    })).filter((t) => t.threat),
    risks: arr(r.risks, 20).map(obj).map((x) => ({
      category: pick(x.category, CATEGORIES, 'Security'),
      title: s(x.title, 160),
      description: s(x.description),
      severity: pick(x.severity, SEVERITIES, 'Medium'),
    })).filter((x) => x.title),
    controls: arr(r.controls, 20).map(obj).map((c) => ({
      service: s(c.service, 100),
      control: s(c.control),
      rationale: s(c.rationale),
      addresses: arr(c.addresses, 12).map((a) => s(a, 8)).filter(Boolean),
    })).filter((c) => c.control),
    checklist: arr(r.checklist, 25).map(obj).map((c) => ({
      priority: pick(c.priority, PRIORITIES, 'P1'),
      item: s(c.item),
      owner: s(c.owner, 80) || 'Developer',
      verification: s(c.verification),
    })).filter((c) => c.item)
      .sort((a, b) => a.priority.localeCompare(b.priority)),
    userStories: arr(r.userStories, 10).map(obj).map((u) => ({
      title: s(u.title, 160),
      story: s(u.story),
      acceptanceCriteria: arr(u.acceptanceCriteria, 8).map((a) => s(a)).filter(Boolean),
    })).filter((u) => u.story),
    assumptions: arr(r.assumptions, 15).map((a) => s(a, 400)).filter(Boolean),
  };
  if (!result.architectureSummary || result.threats.length === 0 || result.checklist.length === 0) {
    throw new ResultShapeError('Model output missing required sections');
  }
  return result;
}
