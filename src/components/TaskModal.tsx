import { useEffect, useState } from 'react';
import type { Subject, Task, Quadrant } from '../types';
import { QUADRANTS } from '../types';
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
    quadrant: Quadrant;
  }) => Promise<boolean>;
  onDelete?: () => void;
  // Hook-level predicate: passed straight through to SubjectSelect
  // so a × delete on a subject row disables itself while the request
  // is in flight.
  isSubjectBusy?: (subjectId: string) => boolean;
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
  const [quadrant, setQuadrant] = useState<Quadrant>(initial.quadrant);
  const [addingSubject, setAddingSubject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      quadrant,
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
          <h2 id="task-modal-title">{mode === 'create' ? 'New task' : 'Edit task'}</h2>
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
              <div className="field">
                <label htmlFor="task-due">Due date</label>
                <input
                  id="task-due"
                  className="input"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={busy}
                />
              </div>

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
                  {busy ? 'Saving…' : mode === 'create' ? 'Add task' : 'Save changes'}
                </button>
              </div>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
