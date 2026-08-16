import { useEffect, useRef, useState } from 'react';
import type { Subject } from '../types';

const ADD_NEW = '__add_new__';
const NONE_VALUE = '';

// A custom subject picker. Renders as a button that looks like a select;
// when opened, lists each subject as a row with a × delete button that
// appears on hover. Replaces the native <select> so we can attach the
// hover-to-delete affordance. Closing behavior matches a native select:
// open → click row → select & close. Clicking × deletes inline (no
// confirm) and keeps the menu open if other subjects remain.
interface Props {
  subjects: Subject[];
  value: string; // '' = None
  onChange: (id: string) => void;
  onDelete: (id: string) => Promise<boolean>;
  onAddNew: () => void;
  disabled?: boolean;
  // Hook-level predicate from useSubjects — true while a delete for
  // this subject id is in flight. We disable the row's × button and
  // show a `…` glyph until the request resolves.
  isBusy?: (id: string) => boolean;
}

export function SubjectSelect({ subjects, value, onChange, onDelete, onAddNew, disabled, isBusy }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = subjects.find((s) => s.id === value) ?? null;

  // Close on outside click / Escape, matching native <select> behavior.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // If the currently-selected subject is deleted from elsewhere, the
  // parent's `value` will become a dangling id — clear it back to ''.
  useEffect(() => {
    if (value && !subjects.some((s) => s.id === value)) {
      onChange(NONE_VALUE);
    }
  }, [subjects, value, onChange]);

  async function handleDelete(s: Subject, e: React.MouseEvent) {
    e.stopPropagation(); // don't bubble to the row's onClick (which would select)
    if (isBusy?.(s.id)) return;
    await onDelete(s.id);
    // Keep the menu open so the user can delete multiple in a row.
  }

  function handleSelect(action: string) {
    if (action === ADD_NEW) {
      onAddNew();
    } else {
      onChange(action);
    }
    setOpen(false);
  }

  return (
    <div className="subject-select" ref={rootRef}>
      <button
        type="button"
        className="subject-select-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        {selected ? (
          <span className="subject-select-value">
            <span
              className="subject-dot"
              style={{ backgroundColor: selected.color ?? 'var(--muted)' }}
              aria-hidden="true"
            />
            {selected.name}
          </span>
        ) : (
          <span className="subject-select-value is-placeholder">— None —</span>
        )}
        <span className="subject-select-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <ul
          className="subject-select-menu"
          role="listbox"
          style={{
            backgroundColor: 'var(--modal-solid-bg, #14172b)',
            opacity: 1,
            zIndex: 99999,
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.95)',
          }}
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === NONE_VALUE}
              className={`subject-select-row${value === NONE_VALUE ? ' is-selected' : ''}`}
              onClick={() => handleSelect(NONE_VALUE)}
            >
              <span className="subject-select-row-name muted">— None —</span>
            </button>
          </li>

          {subjects.map((s) => {
            const isSelected = s.id === value;
            const busy = isBusy?.(s.id) ?? false;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`subject-select-row${isSelected ? ' is-selected' : ''}`}
                  onClick={() => handleSelect(s.id)}
                >
                  <span
                    className="subject-dot"
                    style={{ backgroundColor: s.color ?? 'var(--muted)' }}
                    aria-hidden="true"
                  />
                  <span className="subject-select-row-name">{s.name}</span>
                  <span
                    role="button"
                    tabIndex={busy ? -1 : 0}
                    className="subject-select-delete"
                    aria-label={`Delete ${s.name}`}
                    title={`Delete ${s.name}`}
                    aria-disabled={busy || undefined}
                    onClick={(e) => handleDelete(s, e)}
                    onKeyDown={(e) => {
                      if (busy) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleDelete(s, e as unknown as React.MouseEvent);
                      }
                    }}
                  >
                    {busy ? '…' : '×'}
                  </span>
                </button>
              </li>
            );
          })}

          <li className="subject-select-add">
            <button
              type="button"
              className="subject-select-row is-add"
              onClick={() => handleSelect(ADD_NEW)}
            >
              <span className="subject-select-row-name">+ Add new subject…</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
