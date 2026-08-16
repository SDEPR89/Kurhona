import { useEffect, useState } from 'react';
import type { Subject, Task, Quadrant, Status, TaskType } from '../types';
import { QUADRANTS, STATUSES } from '../types';
import { SubjectManager } from './SubjectManager';
import { SubjectSelect } from './SubjectSelect';

interface Props {
  mode: 'create' | 'edit';
  initial: Partial<Task> & { quadrant: Quadrant };
  subjects: Subject[];
  onCreateSubject: (name: string, color: string) => Promise<Subject | null>;
  onDeleteSubject: (id: string) => Promise<boolean>;
  onClose: () => void;
  onSave: (data: {
    title: string;
    description: string | null;
    subject_id: string | null;
    due_date: string | null;
    due_time: string | null;
    quadrant: Quadrant;
    status: Status;
    task_type: TaskType;
  }) => Promise<boolean>;
  onDelete?: () => void;
  isSubjectBusy?: (subjectId: string) => boolean;
}

function formatDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayString(): string {
  return formatDateString(new Date());
}

function getTomorrowString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return formatDateString(d);
}

function getInOneHour(): { dateStr: string; timeStr: string } {
  const d = new Date();
  d.setHours(d.getHours() + 1);
  const dateStr = formatDateString(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return { dateStr, timeStr: `${hours}:${minutes}` };
}

function getHumanDateLabel(dateStr: string): string | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;

  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);

  const diffTime = target.getTime() - today.getTime();
  const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';

  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getHumanTimeLabel(timeStr: string): string | null {
  if (!timeStr) return null;
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return null;

  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minStr = String(m).padStart(2, '0');
  return `${hour12}:${minStr} ${period}`;
}

export function TaskModal({
  mode,
  initial,
  subjects,
  onCreateSubject,
  onDeleteSubject,
  onClose,
  onSave,
  onDelete,
  isSubjectBusy,
}: Props) {
  const [title, setTitle] = useState(initial.title ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [subjectId, setSubjectId] = useState<string>(initial.subject_id ?? '');
  const [dueDate, setDueDate] = useState<string>(initial.due_date ?? '');
  const [dueTime, setDueTime] = useState<string>(
    initial.due_time ? initial.due_time.slice(0, 5) : '',
  );
  const [quadrant, setQuadrant] = useState<Quadrant>(initial.quadrant);
  const [status, setStatus] = useState<Status>(initial.status ?? 'not_started');
  const [taskType] = useState<TaskType>(initial.task_type ?? 'homework');
  const [addingSubject, setAddingSubject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  async function handleCreateSubject(name: string, color: string) {
    const created = await onCreateSubject(name, color);
    if (created) {
      setSubjectId(created.id);
      setAddingSubject(false);
    }
    return created;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Title is required');
      return;
    }
    setBusy(true);

    const ok = await onSave({
      title: trimmed,
      description: description.trim() || null,
      subject_id: subjectId || null,
      due_date: dueDate || null,
      due_time: dueTime || null,
      quadrant,
      status,
      task_type: taskType,
    });
    if (!ok) {
      setError("Couldn't save the task. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <header className="modal-header">
          <h2 id="task-modal-title">
            {mode === 'create'
              ? taskType === 'test' ? 'New test' : 'New task'
              : taskType === 'test' ? 'Edit test' : 'Edit task'}
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {addingSubject ? (
          <div className="subject-manager-enter" key="manager">
            <SubjectManager
              existing={subjects}
              onCreate={handleCreateSubject}
              onCancel={() => setAddingSubject(false)}
            />
          </div>
        ) : (
          <form onSubmit={submit} className="task-form task-form--enter" key="form">
            <div className="field">
              <label htmlFor="task-title">Title</label>
              <input
                id="task-title"
                className="input"
                type="text"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Algebra Ch. 3 problems"
                disabled={busy}
              />
            </div>

            <div className="field">
              <label htmlFor="task-subject">Subject</label>
              <SubjectSelect
                subjects={subjects}
                value={subjectId}
                onChange={setSubjectId}
                onDelete={onDeleteSubject}
                onAddNew={() => setAddingSubject(true)}
                disabled={busy}
                isBusy={isSubjectBusy}
              />
            </div>

            {/* Date & Time Input Row */}
            <div className="form-row">
              <div className="field">
                <div className="field-header">
                  <label htmlFor="task-due">Due Date</label>
                  {dueDate && <span className="field-badge">{getHumanDateLabel(dueDate)}</span>}
                </div>
                <div
                  className={`picker-input-wrapper${dueDate ? ' has-value' : ''}`}
                  onClick={(e) => {
                    const input = e.currentTarget.querySelector('input');
                    if (input && 'showPicker' in input) {
                      try { input.showPicker(); } catch {}
                    }
                  }}
                >
                  <svg className="picker-inline-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <input
                    id="task-due"
                    className="input picker-input"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    disabled={busy}
                  />
                  {dueDate && (
                    <button
                      type="button"
                      className="picker-clear-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDueDate('');
                      }}
                      title="Clear date"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>

              <div className="field">
                <div className="field-header">
                  <label htmlFor="task-time">Time <span className="muted">(optional)</span></label>
                  {dueTime && <span className="field-badge">{getHumanTimeLabel(dueTime)}</span>}
                </div>
                <div
                  className={`picker-input-wrapper${dueTime ? ' has-value' : ''}`}
                  onClick={(e) => {
                    const input = e.currentTarget.querySelector('input');
                    if (input && 'showPicker' in input) {
                      try { input.showPicker(); } catch {}
                    }
                  }}
                >
                  <svg className="picker-inline-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <input
                    id="task-time"
                    className="input picker-input"
                    type="time"
                    value={dueTime}
                    onChange={(e) => setDueTime(e.target.value)}
                    disabled={busy}
                  />
                  {dueTime && (
                    <button
                      type="button"
                      className="picker-clear-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDueTime('');
                      }}
                      title="Clear time"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Quick Preset Badges */}
            <div className="quick-presets-bar">
              <button
                type="button"
                className={`preset-chip-btn${dueDate === getTodayString() ? ' is-active' : ''}`}
                onClick={() => setDueDate(getTodayString())}
              >
                Today
              </button>
              <button
                type="button"
                className={`preset-chip-btn${dueDate === getTomorrowString() ? ' is-active' : ''}`}
                onClick={() => setDueDate(getTomorrowString())}
              >
                Tomorrow
              </button>
              <button
                type="button"
                className="preset-chip-btn preset-chip-btn--urgent"
                onClick={() => {
                  const { dateStr, timeStr } = getInOneHour();
                  setDueDate(dateStr);
                  setDueTime(timeStr);
                }}
              >
                ⚡ In 1 Hour
              </button>
              {(dueDate || dueTime) && (
                <button
                  type="button"
                  className="preset-chip-btn preset-chip-btn--clear"
                  onClick={() => {
                    setDueDate('');
                    setDueTime('');
                  }}
                >
                  Reset
                </button>
              )}
            </div>

            {/* Visual Quadrant Selector */}
            {taskType !== 'test' && (
              <div className="field">
                <label>Priority / Quadrant</label>
                <div className="quadrant-selector-grid">
                  {QUADRANTS.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      className={`quadrant-card-btn q-${q.id}${quadrant === q.id ? ' is-active' : ''}`}
                      onClick={() => setQuadrant(q.id)}
                      disabled={busy}
                    >
                      <span className="q-badge">Q{q.order}</span>
                      <span className="q-title">{q.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Visual Status Selector */}
            <div className="field">
              <label>Status</label>
              <div className="status-pill-group">
                {STATUSES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`status-pill-btn s-${s.id}${status === s.id ? ' is-active' : ''}`}
                    onClick={() => setStatus(s.id)}
                    disabled={busy}
                  >
                    <span className={`status-dot s-dot-${s.id}`} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="task-description">
                Description <span className="muted">(optional)</span>
              </label>
              <textarea
                id="task-description"
                className="input textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes, page numbers, etc."
                rows={2}
                disabled={busy}
              />
            </div>

            {error && <p className="error">{error}</p>}

            <footer className="modal-footer">
              <div>
                {mode === 'edit' && onDelete && (
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={onDelete}
                    disabled={busy}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div className="modal-footer-right">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={onClose}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? 'Saving…' : mode === 'create' ? (taskType === 'test' ? 'Add test' : 'Add task') : 'Save changes'}
                </button>
              </div>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
