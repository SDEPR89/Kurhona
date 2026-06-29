import type { Quadrant } from '../types';

// ---------------------------------------------------------------------------
// Droppable / draggable id conventions for the matrix + calendar.
//
// Both the matrix (Eisenhower quadrants) and the calendar share a single
// DndContext (Dashboard.tsx). To keep the dispatch unambiguous we
// encode each id with a prefix:
//   - `quadrant:<id>`  — append strip of a non-empty quadrant
//   - `empty:<id>`     — the dashed-border <ul> of an empty quadrant
//   - `<taskId>`       — bare task id, used by SortableContext
//   - `task:<taskId>`  — calendar draggable dot
//   - `day:<isoDate>`  — calendar day cell (droppable)
//
// `decodeDropTarget` in src/lib/reorder.ts understands `quadrant:<id>`
// and bare task ids; the empty variant is normalized to the canonical
// `quadrant:<id>` form by `getEffectiveOverId` below before reaching
// the reorder pipeline. Calendar ids stay self-contained because they
// are routed through a separate path in handleDragEnd.
// ---------------------------------------------------------------------------

export const QUADRANT_PREFIX = 'quadrant:';
export const EMPTY_PREFIX = 'empty:';

export function isQuadrantId(id: string): id is `${typeof QUADRANT_PREFIX}${Quadrant}` {
  return id.startsWith(QUADRANT_PREFIX);
}

export function isEmptyQuadrantId(id: string): id is `${typeof EMPTY_PREFIX}${Quadrant}` {
  return id.startsWith(EMPTY_PREFIX);
}

export function quadrantIdFromDroppable(id: string): Quadrant {
  return id.slice(QUADRANT_PREFIX.length) as Quadrant;
}

export function quadrantIdFromEmpty(id: string): Quadrant {
  return id.slice(EMPTY_PREFIX.length) as Quadrant;
}

// Translate any "drop on this quadrant" id (both `quadrant:<id>` and
// `empty:<id>`) into the canonical `quadrant:<id>` form so downstream
// logic doesn't need to know about the empty variant.
export function getEffectiveOverId(id: string): string {
  if (isEmptyQuadrantId(id)) return `${QUADRANT_PREFIX}${quadrantIdFromEmpty(id)}`;
  return id;
}

export const CALENDAR_TASK_ID_PREFIX = 'task:';
export const CALENDAR_DAY_ID_PREFIX = 'day:';

export function isCalendarTaskId(id: string): boolean {
  return id.startsWith(CALENDAR_TASK_ID_PREFIX);
}

export function decodeCalendarTaskId(id: string): string {
  return id.slice(CALENDAR_TASK_ID_PREFIX.length);
}

export function decodeCalendarDayId(id: string): string {
  return id.slice(CALENDAR_DAY_ID_PREFIX.length);
}