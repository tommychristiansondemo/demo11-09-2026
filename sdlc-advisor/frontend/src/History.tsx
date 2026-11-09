import type { Summary } from './api';

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function History({ items, activeId, ttlDays, onOpen, onDelete }: { items: Summary[]; activeId: string | null; ttlDays: number; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <div className="history">
      <h2>History</h2>
      <p className="muted small">Your assessments are deleted automatically after {ttlDays} days.</p>
      {items.length === 0 ? <p className="muted">No assessments yet.</p> : (
        <ul>
          {items.map((i) => (
            <li key={i.assessmentId} className={i.assessmentId === activeId ? 'active' : ''}>
              <button className="history-item" onClick={() => onOpen(i.assessmentId)} aria-current={i.assessmentId === activeId ? 'true' : undefined}>
                <span className="title">{i.title}</span>
                <span className="meta">
                  <span className={`badge status-${i.status.toLowerCase()}`}>{i.status === 'COMPLETE' ? (i.overallRisk ?? 'Done') : i.status.toLowerCase()}</span>
                  <time dateTime={i.createdAt}>{fmt(i.createdAt)}</time>
                </span>
              </button>
              <button className="icon-btn" aria-label={`Delete assessment ${i.title}`} title="Delete"
                onClick={() => { if (window.confirm('Delete this assessment?')) onDelete(i.assessmentId); }}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
