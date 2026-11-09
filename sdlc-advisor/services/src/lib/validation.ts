import { COMPONENTS, DATA_CLASSIFICATIONS, EXPOSURES, LIMITS } from './catalog';

export interface AssessmentInput {
  title: string;
  description: string;
  components: string[];
  dataClassifications: string[];
  exposure: string;
  syntheticConfirmed: true;
}

export class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super('Validation failed');
  }
}

const componentIds = new Set<string>(COMPONENTS.map((c) => c.id));
const dataIds = new Set<string>(DATA_CLASSIFICATIONS.map((d) => d.id));
const exposureIds = new Set<string>(EXPOSURES.map((e) => e.id));

// Strip control characters (except tab/newline) and normalise whitespace/newlines.
export function cleanText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
}

export function parseAssessmentInput(raw: unknown): AssessmentInput {
  const issues: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(['Request body must be a JSON object.']);
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set(['title', 'description', 'components', 'dataClassifications', 'exposure', 'syntheticConfirmed']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) issues.push(`Unexpected field: ${key.slice(0, 40)}`);
  }

  const title = typeof body.title === 'string' ? cleanText(body.title) : '';
  if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) {
    issues.push(`title must be ${LIMITS.titleMin}-${LIMITS.titleMax} characters.`);
  }

  const description = typeof body.description === 'string' ? cleanText(body.description) : '';
  if (description.length < LIMITS.descriptionMin || description.length > LIMITS.descriptionMax) {
    issues.push(`description must be ${LIMITS.descriptionMin}-${LIMITS.descriptionMax} characters.`);
  }

  const components = Array.isArray(body.components) ? body.components : null;
  if (!components || components.length === 0 || components.length > LIMITS.maxComponents) {
    issues.push(`components must list 1-${LIMITS.maxComponents} items.`);
  } else if (!components.every((c) => typeof c === 'string' && componentIds.has(c))) {
    issues.push('components contains an unsupported value.');
  }

  const dataClassifications = Array.isArray(body.dataClassifications) ? body.dataClassifications : null;
  if (!dataClassifications || dataClassifications.length === 0 || dataClassifications.length > dataIds.size) {
    issues.push('dataClassifications must list at least one item.');
  } else if (!dataClassifications.every((d) => typeof d === 'string' && dataIds.has(d))) {
    issues.push('dataClassifications contains an unsupported value.');
  }

  if (typeof body.exposure !== 'string' || !exposureIds.has(body.exposure)) {
    issues.push('exposure must be one of: ' + [...exposureIds].join(', ') + '.');
  }

  if (body.syntheticConfirmed !== true) {
    issues.push('You must confirm the description contains only synthetic or nonconfidential information.');
  }

  if (issues.length) throw new ValidationError(issues);
  return {
    title,
    description,
    components: [...new Set(components as string[])],
    dataClassifications: [...new Set(dataClassifications as string[])],
    exposure: body.exposure as string,
    syntheticConfirmed: true,
  };
}

export const ASSESSMENT_ID_RE = /^[0-9]{17}[a-f0-9]{8}$/;
