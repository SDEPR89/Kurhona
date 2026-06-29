import type { Task } from '../types';

// Sort by `sort_order` ascending when present, `created_at` descending
// as the tiebreaker for null rows. Matches the contract on
// Task.sort_order in src/types.ts. The previous due-date sort was a
// per-user preference; the user removed the toggle, so drag-driven
// order is now the source of truth.
export function taskSort(a: Task, b: Task): number {
  const ao = a.sort_order;
  const bo = b.sort_order;
  if (ao !== null && bo !== null) {
    if (ao !== bo) return ao - bo;
  } else if (ao !== null) {
    return -1; // a is sorted, b is null → a first
  } else if (bo !== null) {
    return 1; // b is sorted, a is null → b first
  }
  return b.created_at.localeCompare(a.created_at);
}