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
    // 'HH:MM' from the time input, or null. Postgres normalizes to
    // 'HH:MM:SS' on write and we read it back the same way.
    due_time: string | null;
    quadrant: Quadrant;
    status: Status;
    task_type: TaskType;
  }) => Promise<boolean>;
  onDelete?: () => void;
  // Hook-level predicate: passed straight through to SubjectSelect
  // so a × delete on a subject row disables itself while the request
  // is in flight.
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

function getPlusDaysString(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
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
  // Postgres time round-trips as 'HH:MM:SS'; the <input type="time">
  // expects 'HH:MM'. Slice the first 5 chars on the way in so the
  // input shows the right value when editing an existing task.
  const [dueTime, setDueTime] = useState<string>(
    initial.due_time ? initial.due_time.slice(0, 5) : '',
  );
  const [quadrant, setQuadrant] = useState<Quadrant>(initial.quadrant);
  const [status, setStatus] = useState<Status>(initial.status ?? 'not_started');
  // task_type is read-only after the modal opens — it is set at
  // creation time and never changed inside the modal.
  const [taskType] = useState<TaskType>(initial.task_type ?? 'homework');
  const [addingSubject, setAddingSubject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  // Lock body scroll while modal is open + close on Escape.
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
    // `onSave` returns false when the underlying hook call failed
    // (e.g. network). The hook already surfaces a toast in that
    // case; the modal stays open so the user can retry without
    // re-opening. We also show an inline error so the failure
    // is visible from inside the form, not only in the toast.
    const ok = await onSave({
      title: trimmed,
      description: description.trim() || null,
      subject_id: subjectId || null,
      due_date: dueDate || null,
      // Empty string from the <input type="time"> means "no time set" —
      // translate to null so the column stores null rather than ''.
      due_time: dueTime || null,
      quadrant,
      status,
      task_type: taskType,
    });
    if (!ok) {
      setError("Couldn't save the task. Please try again.");
      setBusy(false);
    }
    // On success the parent closes the modal (and unmounts us), so
    // we deliberately don't reset `busy` here.
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
              <label htmlFor="task-description">
                Description <span className="muted">(optional)</span>
              </label>
              <textarea
                id="task-description"
                className="input textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes, page numbers, etc."
                rows={3}
                disabled={busy}
              />
            </div>

            <div className="form-row">
              <div className="field relative-field">
                <label htmlFor="task-due">Due date</label>
                <div className="picker-trigger-box">
                  <button
                    id="task-due"
                    type="button"
                    className={`custom-picker-trigger${dueDate ? ' has-value' : ''}`}
                    onClick={() => {
                      setShowDatePicker(!showDatePicker);
                      setShowTimePicker(false);
                    }}
                    disabled={busy}
                  >
                    <svg className="picker-trigger-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    <span className="picker-trigger-label">
                      {dueDate ? getHumanDateLabel(dueDate) : 'Select date'}
                    </span>
                    {dueDate && (
                      <span
                        className="picker-trigger-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDueDate('');
                        }}
                        title="Clear date"
                      >
                        ×
                      </span>
                    )}
                  </button>
                </div>

                {showDatePicker && (
                  <div className="custom-popover-picker">
                    <div className="popover-section-title">Quick Select Date</div>
                    <div className="popover-grid">
                      <button
                        type="button"
                        className={`popover-option-btn${dueDate === getTodayString() ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueDate(getTodayString());
                          setShowDatePicker(false);
                        }}
                      >
                        Today
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueDate === getTomorrowString() ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueDate(getTomorrowString());
                          setShowDatePicker(false);
                        }}
                      >
                        Tomorrow
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueDate === getPlusDaysString(3) ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueDate(getPlusDaysString(3));
                          setShowDatePicker(false);
                        }}
                      >
                        +3 Days
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueDate === getPlusDaysString(7) ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueDate(getPlusDaysString(7));
                          setShowDatePicker(false);
                        }}
                      >
                        Next Week
                      </button>
                    </div>

                    <div className="popover-divider" />

                    <div className="popover-custom-row">
                      <span className="popover-sublabel">Custom Date:</span>
                      <input
                        type="date"
                        className="input popover-date-input"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                      />
                    </div>

                    <div className="popover-footer">
                      {dueDate && (
                        <button
                          type="button"
                          className="popover-action-btn popover-action-btn--clear"
                          onClick={() => {
                            setDueDate('');
                            setShowDatePicker(false);
                          }}
                        >
                          Clear Date
                        </button>
                      )}
                      <button
                        type="button"
                        className="popover-action-btn popover-action-btn--done"
                        onClick={() => setShowDatePicker(false)}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="field relative-field">
                <label htmlFor="task-time">
                  Time <span className="muted">(optional)</span>
                </label>
                <div className="picker-trigger-box">
                  <button
                    id="task-time"
                    type="button"
                    className={`custom-picker-trigger${dueTime ? ' has-value' : ''}`}
                    onClick={() => {
                      setShowTimePicker(!showTimePicker);
                      setShowDatePicker(false);
                    }}
                    disabled={busy}
                  >
                    <svg className="picker-trigger-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span className="picker-trigger-label">
                      {dueTime ? getHumanTimeLabel(dueTime) : 'Select time'}
                    </span>
                    {dueTime && (
                      <span
                        className="picker-trigger-clear"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDueTime('');
                        }}
                        title="Clear time"
                      >
                        ×
                      </span>
                    )}
                  </button>
                </div>

                {showTimePicker && (
                  <div className="custom-popover-picker">
                    <div className="popover-section-title">Quick Select Time</div>
                    <div className="popover-grid popover-grid--col2">
                      <button
                        type="button"
                        className="popover-option-btn popover-option-btn--urgent"
                        onClick={() => {
                          const { dateStr, timeStr } = getInOneHour();
                          setDueDate(dateStr);
                          setDueTime(timeStr);
                          setShowTimePicker(false);
                        }}
                      >
                        ⚡ In 1 Hour
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueTime === '09:00' ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueTime('09:00');
                          setShowTimePicker(false);
                        }}
                      >
                        🌅 09:00 AM
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueTime === '13:00' ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueTime('13:00');
                          setShowTimePicker(false);
                        }}
                      >
                        ☀️ 01:00 PM
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueTime === '17:00' ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueTime('17:00');
                          setShowTimePicker(false);
                        }}
                      >
                        🌆 05:00 PM
                      </button>
                      <button
                        type="button"
                        className={`popover-option-btn${dueTime === '23:59' ? ' is-active' : ''}`}
                        onClick={() => {
                          setDueTime('23:59');
                          setShowTimePicker(false);
                        }}
                      >
                        🌙 11:59 PM
                      </button>
                    </div>

                    <div className="popover-divider" />

                    <div className="popover-custom-row">
                      <span className="popover-sublabel">Exact Time:</span>
                      <input
                        type="time"
                        className="input popover-time-input"
                        value={dueTime}
                        onChange={(e) => setDueTime(e.target.value)}
                      />
                    </div>

                    <div className="popover-footer">
                      {dueTime && (
                        <button
                          type="button"
                          className="popover-action-btn popover-action-btn--clear"
                          onClick={() => {
                            setDueTime('');
                            setShowTimePicker(false);
                          }}
                        >
                          Clear Time
                        </button>
                      )}
                      <button
                        type="button"
                        className="popover-action-btn popover-action-btn--done"
                        onClick={() => setShowTimePicker(false)}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="form-row">
              {taskType !== 'test' && (
                <div className="field">
                  <label htmlFor="task-quadrant">Quadrant</label>
                  <select
                    id="task-quadrant"
                    className="input"
                    value={quadrant}
                    onChange={(e) => setQuadrant(e.target.value as Quadrant)}
                    disabled={busy}
                  >
                    {QUADRANTS.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.order}. {q.title} — {q.subtitle}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field">
                <label htmlFor="task-status">Status</label>
                <select
                  id="task-status"
                  className="input"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status)}
                  disabled={busy}
                >
                  {STATUSES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
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
