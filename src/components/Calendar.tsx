import { useMemo, useState } from 'react';
import type { Task, Quadrant } from '../types';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import './Calendar.css';

interface Props {
  // Calendar filters internally to active (not completed) tasks with a
  // non-null due_date. Tasks without a due_date are skipped because the
  // calendar has nothing to place on a day for them.
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onAddOnDate: (date: string) => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const MAX_DOTS = 3;

// `cursor` is the first day of the month being viewed (midnight local
// time). We always render a fixed 6-row grid (42 cells) so the layout
// doesn't jump when navigating across months — some months need 5
// rows, some 6, but always 42 cells keeps the height stable.
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Format a Date as YYYY-MM-DD in the user's local timezone. We can't
// use toISOString() because it converts to UTC — a date typed locally
// as 2026-06-26 becomes 2026-06-25T17:00:00Z in Bangkok, which then
// round-trips back as a different local day. Building the string from
// the local fields keeps the date stable across the trip through
// Supabase (which stores as date, no TZ).
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// `cell:<isoDate>` matches the droppable id used by <DayCell> below.
// The Dashboard's onDragEnd handler reads this prefix to route a
// calendar drop into reschedule instead of the matrix reorder path.
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

interface DayCellProps {
  date: Date;
  isoDate: string;
  inMonth: boolean;
  isToday: boolean;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onAdd: (isoDate: string) => void;
}

function DayCell({ date, isoDate, inMonth, isToday, tasks, onTaskClick, onAdd }: DayCellProps) {
  // Each cell is a droppable target. We disable it while a reorder
  // RPC is mid-flight (the parent passes reorderDisabled through
  // here indirectly — the Dashboard's existing reorderBusy flag
  // covers the matrix; the calendar's reschedule path is a single
  // updateTask call which useTasks's runBusy handles on the task id).
  const { setNodeRef, isOver } = useDroppable({
    id: `${CALENDAR_DAY_ID_PREFIX}${isoDate}`,
  });

  const visible = tasks.slice(0, MAX_DOTS);
  const overflow = tasks.length - visible.length;

  const classes = [
    'calendar-cell',
    !inMonth && 'calendar-cell--out',
    isToday && 'calendar-cell--today',
    isOver && 'calendar-cell--over',
  ]
    .filter(Boolean)
    .join(' ');

  // The cell click handler is on the wrapper div, but task dots
  // stopPropagation so clicking a dot opens edit instead of create.
  const handleCellClick = () => onAdd(isoDate);

  // Build the aria-label from the actual date so screen readers
  // announce the day instead of an opaque grid cell.
  const ariaLabel = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`;

  return (
    <div
      ref={setNodeRef}
      className={classes}
      role="gridcell"
      aria-label={ariaLabel}
      onClick={handleCellClick}
    >
      <span className="calendar-cell-number">{date.getDate()}</span>
      <div className="calendar-cell-dots" aria-hidden="true">
        {visible.map((t) => (
          <TaskDot key={t.id} task={t} onClick={onTaskClick} />
        ))}
        {overflow > 0 && (
          <span className="calendar-overflow">+{overflow}</span>
        )}
      </div>
    </div>
  );
}

interface TaskDotProps {
  task: Task;
  onClick: (task: Task) => void;
}

function TaskDot({ task, onClick }: TaskDotProps) {
  // Each dot is draggable. The id `task:<id>` lets the Dashboard
  // distinguish calendar drags from matrix drags (which use bare task
  // ids). useDraggable's transform drives a small CSS translate.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${CALENDAR_TASK_ID_PREFIX}${task.id}`,
  });

  const handleClick = (e: React.MouseEvent) => {
    // Click is for opening the edit modal; drag is for reschedule.
    // dnd-kit's PointerSensor fires before click if the user actually
    // dragged (activationConstraint distance=8), so this only runs
    // for taps/clicks.
    e.stopPropagation();
    onClick(task);
  };

  // Inline background — use the `background` shorthand so any user-agent
  // `background-color` on `<button>` is fully overridden. The CSS class
  // also sets `background: transparent` as a base, but the inline style
  // wins by specificity anyway. Doing it here as a shorthand means
  // quadrant colors can't be silently swallowed by button defaults in
  // any browser.
  const style: React.CSSProperties = {
    background: `var(--q-${task.quadrant})`,
    opacity: isDragging ? 0.4 : 1,
    cursor: isDragging ? 'grabbing' : 'grab',
    touchAction: 'none',
    ...(attributes as { style?: React.CSSProperties }).style,
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`calendar-task-dot calendar-task-dot--${task.quadrant as Quadrant}`}
      style={style}
      title={task.title}
      aria-label={`${task.title} (${task.quadrant})`}
      onClick={handleClick}
      {...listeners}
      {...attributes}
    />
  );
}

export function Calendar({ tasks, onTaskClick, onAddOnDate }: Props) {
  // Default the cursor to today's month so the first render shows
  // the current month, not January 1970.
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));
  const today = useMemo(() => startOfDay(new Date()), []);

  // Build the day→tasks lookup once per (cursor, tasks) change. We
  // index by ISO date so lookup is O(1) per cell. Tasks without a
  // due_date are skipped — the calendar has nothing to show for them
  // and we want to keep this fast even when there are hundreds of
  // undated tasks in the matrix.
  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.completed_at) continue;
      if (!t.due_date) continue;
      const list = map.get(t.due_date);
      if (list) list.push(t);
      else map.set(t.due_date, [t]);
    }
    return map;
  }, [tasks]);

  // 42-cell grid: first cell is the Sunday on or before the 1st of
  // the cursor's month, last cell is the Saturday on or after the
  // last day of that month. Six rows covers every possible month
  // (longest is 31 days starting on a Sunday → 5 rows; with leading
  // padding for a Saturday-start month, 6 rows).
  const cells = useMemo(() => {
    const first = startOfMonth(cursor);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());

    const out: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      out.push({ date: d, inMonth: d.getMonth() === cursor.getMonth() });
    }
    return out;
  }, [cursor]);

  const monthLabel = `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`;

  return (
    <section className="calendar" aria-label="Task calendar">
      <header className="calendar-header">
        <h2 className="calendar-title">Calendar</h2>
        <div className="calendar-nav">
          <button
            type="button"
            className="btn-secondary calendar-nav-btn"
            onClick={() => setCursor((c) => addMonths(c, -1))}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className="btn-secondary calendar-nav-btn calendar-nav-today"
            onClick={() => setCursor(startOfMonth(new Date()))}
          >
            Today
          </button>
          <span className="calendar-month-label" aria-live="polite">
            {monthLabel}
          </span>
          <button
            type="button"
            className="btn-secondary calendar-nav-btn"
            onClick={() => setCursor((c) => addMonths(c, 1))}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </header>
      <div className="calendar-weekdays" aria-hidden="true">
        {WEEKDAYS.map((d) => (
          <div key={d} className="calendar-weekday">{d}</div>
        ))}
      </div>
      <div className="calendar-grid" role="grid">
        {cells.map(({ date, inMonth }) => {
          const isoDate = toIsoDate(date);
          return (
            <DayCell
              key={isoDate}
              date={date}
              isoDate={isoDate}
              inMonth={inMonth}
              isToday={isSameDay(date, today)}
              tasks={tasksByDate.get(isoDate) ?? []}
              onTaskClick={onTaskClick}
              onAdd={onAddOnDate}
            />
          );
        })}
      </div>
    </section>
  );
}