import type { Task, Subject } from '../types';
import { TaskCard } from './TaskCard';

interface Props {
  activeTasks: Task[];
  doneTasks: Task[];
  subjects: Subject[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (task: Task) => void;
  onToggleComplete: (task: Task) => void;
  onDelete: (task: Task) => void;
  isTaskBusy?: (taskId: string) => boolean;
  onOpenStatusDetail?: (task: Task) => void;
}

function daysUntil(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(isoDate + 'T00:00:00');
  return Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
}

function CountdownBadge({ isoDate }: { isoDate: string | null }) {
  const days = daysUntil(isoDate);
  if (days === null) return null;

  let label: string;
  let mod: string;
  if (days < 0)       { label = 'Past';      mod = 'past'; }
  else if (days === 0){ label = 'Today';      mod = 'today'; }
  else if (days === 1){ label = 'Tomorrow';   mod = 'soon'; }
  else if (days <= 3) { label = `${days}d`;  mod = 'soon'; }
  else if (days <= 7) { label = `${days}d`;  mod = 'week'; }
  else                { label = `${days}d`;  mod = 'far'; }

  return <span className={`tests-badge tests-badge--${mod}`}>{label}</span>;
}

export function TestsView({
  activeTasks,
  doneTasks,
  subjects,
  loading,
  onAdd,
  onEdit,
  onToggleComplete,
  onDelete,
  isTaskBusy,
  onOpenStatusDetail,
}: Props) {
  if (loading) return <p className="dashboard-status">Loading…</p>;

  const renderCard = (task: Task) => {
    const subject = subjects.find((s) => s.id === task.subject_id);
    return (
      <li key={task.id} className="tests-card-row">
        <CountdownBadge isoDate={task.due_date} />
        <TaskCard
          task={task}
          subject={subject}
          onToggleComplete={() => onToggleComplete(task)}
          onClick={() => onEdit(task)}
          onDelete={() => onDelete(task)}
          isBusy={isTaskBusy?.(task.id) ?? false}
          onOpenStatusDetail={
            onOpenStatusDetail ? () => onOpenStatusDetail(task) : undefined
          }
        />
      </li>
    );
  };

  return (
    <div className="tests-view tests-view--enter">

      {/* ── Panel ── */}
      <div className="tests-panel">

        {/* Header */}
        <div className="tests-panel-header">
          <div className="tests-header-left">
            <div className="tests-icon-badge" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round">
                <rect x="8" y="2" width="8" height="4" rx="1" />
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <line x1="9" y1="12" x2="15" y2="12" />
                <line x1="9" y1="16" x2="13" y2="16" />
              </svg>
            </div>
            <div>
              <p className="tests-panel-title">Tests &amp; exams</p>
              <p className="tests-panel-subtitle">
                {activeTasks.length === 0
                  ? 'No upcoming tests — enjoy the calm.'
                  : activeTasks.length === 1
                  ? '1 upcoming test'
                  : `${activeTasks.length} upcoming tests`}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="tests-btn-add"
            onClick={onAdd}
            aria-label="Add test or exam"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add
          </button>
        </div>

        <div className="tests-divider" />

        {/* Upcoming section */}
        <div className="tests-section">
          <div className="tests-section-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>UPCOMING</span>
            <span className="tests-count-pill">{activeTasks.length}</span>
          </div>

          {activeTasks.length === 0 ? (
            <div className="tests-empty">
              <div className="tests-empty-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <line x1="10" y1="9" x2="8" y2="9" />
                </svg>
              </div>
              <p className="tests-empty-title">All clear!</p>
              <p className="tests-empty-body">No upcoming tests scheduled.</p>
            </div>
          ) : (
            <ul className="tests-task-list">
              {activeTasks.map(renderCard)}
            </ul>
          )}
        </div>

        {/* Completed section */}
        {doneTasks.length > 0 && (
          <>
            <div className="tests-divider" />
            <div className="tests-section tests-section--done">
              <div className="tests-section-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>COMPLETED</span>
                <span className="tests-count-pill">{doneTasks.length}</span>
              </div>
              <ul className="tests-task-list tests-task-list--done">
                {doneTasks.map(renderCard)}
              </ul>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
