import { randomBytes } from 'node:crypto';

// Time-sortable id: yyyyMMddHHmmssSSS + 8 hex chars, e.g. 2026110917150012301ab12cd
export function newAssessmentId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '');
  return ts + randomBytes(4).toString('hex');
}
