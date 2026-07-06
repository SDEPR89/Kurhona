// Shared domain types + constants for the Eisenhower matrix tracker.

export type Quadrant = 'do_first' | 'schedule' | 'delegate' | 'eliminate';

// Distinguishes homework tasks (the Eisenhower matrix) from test/exam
// tasks (the single-list Tests tab). Mirrors the DB CHECK constraint in
// supabase/schema.sql. Rows that pre-date the column read back as
// 'homework' via the DB default.
export type TaskType = 'homework' | 'test';

// Homework workflow status. `not_started` is the DB default, so any
// row that pre-dates the status column will read back as `not_started`
// without an extra migration step. Stored as text (not enum) so new
// values can be added without a migration; the CHECK constraint in
// supabase/schema.sql keeps invalid values out at the database layer.
export type Status = 'not_started' | 'in_progress' | 'ready_to_submit' | 'submitted';

export interface Subject {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  subject_id: string | null;
  due_date: string | null; // ISO date (YYYY-MM-DD)
  // Optional time of day in 'HH:MM:SS' (Postgres time), or null. The
  // time input in TaskModal produces 'HH:MM' which Postgres coerces;
  // we read it back as 'HH:MM:SS' over PostgREST.
  due_time: string | null;
  quadrant: Quadrant;
  completed_at: string | null;
  // Workflow status — one of the 4 Status values. Has a DB default of
  // 'not_started', so any row that pre-dates the column will read back
  // as 'not_started' automatically.
  status: Status;
  // Whether this is a homework task (Eisenhower matrix) or a test/exam
  // task (Tests tab single list). DB default is 'homework'.
  task_type: TaskType;
  created_at: string;
  updated_at: string;
  // Dense per-(user, quadrant) order set by drag-and-drop. 0..N-1
  // within each quadrant; null means the row hasn't been touched since
  // the user dragged anything in this quadrant (or the row pre-dates
  // the feature). Sorts by sort_order ascending when present, then by
  // created_at desc as the tiebreaker for null rows.
  sort_order: number | null;
}

// Insert payload shape — Supabase fills id / user_id / timestamps via defaults
// and RLS, but we keep them optional so callers can omit.
export type TaskInsert = {
  title: string;
  description?: string | null;
  subject_id?: string | null;
  due_date?: string | null;
  // 'HH:MM' from the <input type="time"> in TaskModal, or null. We
  // let Postgres normalize to 'HH:MM:SS' on the way in.
  due_time?: string | null;
  quadrant: Quadrant;
  // Omit on insert; the DB default 'not_started' is fine. The client
  // can also pass an explicit value to override.
  status?: Status;
  // 'homework' for the Eisenhower matrix, 'test' for the Tests tab.
  // Omit on insert to get the DB default 'homework'.
  task_type?: TaskType;
  // Omit on insert; the row defaults to null and the dashboard treats
  // null as "append to the end" the next time the user drags in this
  // quadrant.
  sort_order?: number | null;
};

export type SubjectInsert = {
  name: string;
  color?: string | null;
};

// Metadata for rendering the 4 quadrants in canonical order (urgent × important).
export const QUADRANTS: readonly {
  id: Quadrant;
  title: string;
  subtitle: string;
  /** Order on screen (1..4). */
  order: 1 | 2 | 3 | 4;
}[] = [
  { id: 'do_first',  title: 'Do First',    subtitle: 'Urgent & important',     order: 1 },
  { id: 'schedule',  title: 'Schedule',    subtitle: 'Important, not urgent',  order: 2 },
  { id: 'delegate',  title: 'Delegate',    subtitle: 'Urgent, not important',  order: 3 },
  { id: 'eliminate', title: 'Eliminate',   subtitle: 'Neither',                order: 4 },
] as const;

// Metadata for the 4 workflow statuses. `tokenBg` / `tokenRing`
// reference CSS custom properties so the light/dark themes can map
// each status to a different palette without changing this list.
// Used by the TaskCard status dot, the TaskModal status select, and
// the full-page StatusDetail picker on mobile.
export const STATUSES: readonly {
  id: Status;
  label: string;
  tokenBg: string;
  tokenRing: string;
}[] = [
  { id: 'not_started',     label: 'Not started',     tokenBg: 'var(--status-not-started-bg)',    tokenRing: 'var(--status-not-started-ring)' },
  { id: 'in_progress',     label: 'In progress',     tokenBg: 'var(--status-in-progress-bg)',    tokenRing: 'var(--status-in-progress-ring)' },
  { id: 'ready_to_submit', label: 'Ready to submit', tokenBg: 'var(--status-ready-bg)',          tokenRing: 'var(--status-ready-ring)' },
  { id: 'submitted',       label: 'Submitted',       tokenBg: 'var(--status-submitted-bg)',      tokenRing: 'var(--status-submitted-ring)' },
] as const;
