import { useCallback, useMemo, useRef, useState } from 'react';
import { useTasks } from '../hooks/useTasks';
import { useSubjects } from '../hooks/useSubjects';
import { useTheme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';
import { Quadrant } from './Quadrant';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
import { SettingsModal } from './SettingsModal';
import { Calendar } from './Calendar';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import { QUADRANTS } from '../types';
import type { Quadrant as QuadrantId, Task, Subject } from '../types';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  rectIntersection,
  getFirstCollision,
  type CollisionDetection,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent, DragOverEvent, DragCancelEvent } from '@dnd-kit/core';
import './Dashboard.css';
import {
  CALENDAR_TASK_ID_PREFIX,
  CALENDAR_DAY_ID_PREFIX,
  decodeCalendarTaskId,
  decodeCalendarDayId,
} from './Calendar';

type View = 'active' | 'done';

interface Props {
  userId: string;
  userEmail: string | null;
  userUsername: string | null;
  userDisplayUsername: string | null;
  // True when the user signed in anonymously. The header shows
  // "Guest" instead of trying to fall back to a missing username
  // or email, and the Settings modal surfaces an upgrade path.
  isAnonymous: boolean;
  onSignOut: () => void;
  onUsernameUpdated: (newUsername: string) => void;
  onAccountDeleted: () => void;
  // Fired after the user attaches an email + password in the
  // Settings → Upgrade section. App.tsx flips the local user out
  // of "anonymous" mode.
  onAccountUpgraded: (newEmail: string) => void;
}

// Drop targets that represent the whole quadrant (the dashed
// "no tasks yet" box for an empty quadrant, and the strip above
// the "+ Add task" button for a non-empty quadrant) share the id
// `quadrant:<id>`. Helper for the collision-detection strategy
// below — see `handleDragOver` for the matching logic.
const QUADRANT_PREFIX = 'quadrant:';
function isQuadrantId(id: string): id is `${typeof QUADRANT_PREFIX}${QuadrantId}` {
  return id.startsWith(QUADRANT_PREFIX);
}
function quadrantIdFromDroppable(id: string): QuadrantId {
  return id.slice(QUADRANT_PREFIX.length) as QuadrantId;
}

export function Dashboard({
  userId,
  userEmail,
  userUsername,
  userDisplayUsername,
  isAnonymous,
  onSignOut,
  onUsernameUpdated,
  onAccountDeleted,
  onAccountUpgraded,
}: Props) {
  const toast = useToast();
  const {
    tasks,
    liveTasks,
    setLiveTasks,
    snapshotLiveTasks,
    restoreLiveTasks,
    clearLiveTasksSnapshot,
    loading,
    error,
    createTask,
    updateTask,
    setDueDate,
    completeTask,
    uncompleteTask,
    deleteTask,
    reorder,
    reorderBusy,
    isBusy: isTaskBusy,
  } = useTasks(userId, { showError: toast.showError });
  const { subjects, addSubject, deleteSubject, isBusy: isSubjectBusy } = useSubjects(userId, {
    showError: toast.showError,
  });
  const confirm = useConfirm();

  const [view, setView] = useState<View>('active');
  const [editing, setEditing] = useState<
    | { kind: 'create'; quadrant: QuadrantId; dueDate?: string }
    | { kind: 'edit'; task: Task }
    | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Drag-and-drop state. `activeDragId` is the task id currently being
  // dragged (set on dragstart, cleared on dragend). We use it to
  // render a translucent clone in <DragOverlay>.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // `lastOverId` is the cached drop target from the most recent
  // dragover tick. After a cross-container move (onDragOver changes
  // the dragged card's quadrant), dnd-kit briefly reports `over` as
  // null while the layout shifts; reusing the cached id keeps the
  // collision chain alive across that frame.
  const lastOverIdRef = useRef<string | null>(null);
  // Original source quadrant of the active drag, captured on
  // dragstart. By the time onDragEnd fires the live mirror has
  // already re-bucketed the dragged card into the destination, so
  // `active.quadrant` is no longer the true source. We pass this
  // value to `reorder` so `applyMove` computes the cross-quadrant
  // move correctly and rewrites the source bucket's `sort_order`
  // densely.
  const dragSourceQuadrantRef = useRef<QuadrantId | null>(null);
  // Flag set right after we re-bucket the dragged card into a new
  // container so the next dragover tick can fall back to the cached
  // id when dnd-kit's pointer math hasn't caught up. Cleared on the
  // next animation frame.
  const recentlyMovedToNewContainerRef = useRef(false);
  const { theme, toggle: toggleTheme } = useTheme();

  // dnd-kit sensors. PointerSensor has an 8px activation distance so
  // stationary clicks on the card body still reach the inner button
  // (and the checkbox / delete ×). KeyboardSensor makes the matrix
  // draggable via Tab → Space → arrow → Space for accessibility.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  // Bucket the live mirror by quadrant. While a drag is in flight
  // this reflects the in-flight reordering; otherwise it mirrors
  // `tasks` exactly (the hook reseeds `liveTasks` from `tasks`).
  const liveGroups = useMemo(() => {
    const groups: Record<QuadrantId, Task[]> = {
      do_first: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };
    for (const t of liveTasks) {
      if (!t.completed_at) groups[t.quadrant].push(t);
    }
    for (const q of Object.keys(groups) as QuadrantId[]) {
      groups[q].sort(taskSort);
    }
    return groups;
  }, [liveTasks]);

  // 3-tier collision strategy (the canonical dnd-kit multiple-
  // containers chain). `pointerWithin` wins when the pointer is over
  // a card (highest fidelity). `rectIntersection` catches the empty
  // quadrant <ul> even when its child is also a droppable, and the
  // append strip when the pointer sits below the last card.
  // `closestCenter` is the fallback for the in-list reorder case
  // (pointer between two cards, no direct hit).
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // If the pointer just moved a card across containers, dnd-kit
      // may briefly report no collision while the layout settles.
      // Hold the previous target so the drag doesn't appear to drop.
      if (recentlyMovedToNewContainerRef.current && lastOverIdRef.current) {
        return [{ id: lastOverIdRef.current }];
      }

      // 1) Pointer-direct: highest fidelity, picks the card under
      //    the cursor including across quadrant boundaries.
      const pointerHits = pointerWithin(args);
      if (pointerHits.length > 0) {
        const first = pointerHits[0];
        lastOverIdRef.current = String(first.id);
        return [first];
      }

      // 2) Rect intersection: catches the empty-quadrant <ul> and the
      //    append strip when the pointer sits over the dashed border
      //    rather than a card body.
      const rectHits = rectIntersection(args);
      if (rectHits.length > 0) {
        const first = getFirstCollision(rectHits, 'id');
        if (first) {
          lastOverIdRef.current = String(first);
          return [{ id: first }];
        }
      }

      // 3) Closest center: in-list reorder when the pointer is
      //    between two cards and nothing else is under it.
      const centerHits = closestCenter(args);
      if (centerHits.length > 0) {
        const first = centerHits[0];
        lastOverIdRef.current = String(first.id);
        return [first];
      }

      // No hit — but if we have a cached id and we're mid-move,
      // keep returning it so the drag doesn't appear to "drop" on
      // the gap between cards / quadrants. This is the case when the
      // pointer is between two containers and dnd-kit can't decide.
      if (lastOverIdRef.current) return [{ id: lastOverIdRef.current }];
      return [];
    },
    [],
  );

  function findLiveContainer(id: string): QuadrantId | null {
    // Droppable ids for whole-quadrant surfaces are `quadrant:<id>`.
    if (isQuadrantId(id)) return quadrantIdFromDroppable(id);
    // Otherwise the id is a task id; look up its current bucket in
    // the live mirror. During a drag this respects the in-flight
    // reordering.
    const t = liveTasks.find((x) => x.id === id);
    return t ? t.quadrant : null;
  }

  function handleDragStart(e: DragStartEvent) {
    const activeId = String(e.active.id);
    // Calendar drags (id prefix `task:`) bypass the matrix's live-
    // mirror machinery entirely — the calendar renders the dragging
    // dot's own opacity, and onDragEnd routes the drop to setDueDate.
    if (activeId.startsWith(CALENDAR_TASK_ID_PREFIX)) {
      setActiveDragId(activeId);
      lastOverIdRef.current = null;
      dragSourceQuadrantRef.current = null;
      return;
    }
    setActiveDragId(activeId);
    snapshotLiveTasks();
    lastOverIdRef.current = activeId;
    // Capture the source quadrant before any re-bucketing. The live
    // mirror at this point still reflects the canonical `tasks` (no
    // drag mutations have happened yet), so this is the true origin.
    const t = liveTasks.find((x) => x.id === activeId);
    dragSourceQuadrantRef.current = t ? t.quadrant : null;
  }

  // Mid-drag re-bucket. dnd-kit calls onDragOver continuously while
  // the pointer moves; if `over` is in a different container than the
  // active item we move the active item to the new container at the
  // right index. This is what makes cross-quadrant drag actually
  // track the cursor — without it the dragged card's transform is
  // bound to its source SortableContext and it never visually enters
  // the destination quadrant.
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Calendar drags don't need the matrix's re-bucket logic — the
    // dot is already opaque-on-grab and we only care about the final
    // day drop. Skip here so we don't accidentally re-bucket a matrix
    // task that happens to share an id prefix pattern (none today,
    // but defensive).
    if (activeId.startsWith(CALENDAR_TASK_ID_PREFIX)) {
      lastOverIdRef.current = overId.startsWith(CALENDAR_DAY_ID_PREFIX) ? overId : null;
      return;
    }

    if (activeId === overId) return;

    const activeContainer = findLiveContainer(activeId);
    const overContainer = findLiveContainer(overId);
    if (!activeContainer || !overContainer) return;
    if (activeContainer === overContainer) {
      // Same container — let dnd-kit's SortableContext handle the
      // visual reorder on its own. We still cache the id so the
      // collision chain can fall back to it.
      lastOverIdRef.current = overId;
      return;
    }

    // Cross-container move. Compute the insert index in the
    // destination using the dragged item's vertical position
    // relative to the hovered item's center. Pointer-Y > target-Y
    // means the user is dragging downward, so the drop should land
    // *after* the hovered card.
    setLiveTasks((prev) => {
      const activeIdx = prev.findIndex((t) => t.id === activeId);
      if (activeIdx === -1) return prev;
      const activeItem = prev[activeIdx];

      // Build the destination list with the active item removed.
      // `insertIdx` is the index within this list where the moved
      // card should land; len = append.
      const destList = prev.filter((t) => t.quadrant === overContainer && t.id !== activeId);
      let insertIdx = destList.length;
      if (!isQuadrantId(overId)) {
        // Dropping on a card: insert at the hovered card's index,
        // adjusted for the pointer-Y heuristic.
        const overIdxInDest = destList.findIndex((t) => t.id === overId);
        if (overIdxInDest !== -1) {
          const activeRect = active.rect.current.translated;
          const overRect = over.rect;
          const isBelow =
            activeRect && overRect && activeRect.top > overRect.top + overRect.height / 2;
          insertIdx = isBelow ? overIdxInDest + 1 : overIdxInDest;
        }
      }

      // Drop the active item from the full array, then splice the
      // moved card in at the right position. We anchor on either
      // the predecessor in the destination list (insertIdx > 0) or
      // the first remaining row of the destination in `next`
      // (insertIdx === 0); if the destination is empty, just append.
      const next = prev.filter((_, i) => i !== activeIdx);
      // Stamp sort_order to the visual insert position so liveGroups
      // (which sorts by sort_order asc) renders the card where the
      // user dropped it. The reorder RPC rewrites sort_order densely
      // on dragend, so this temporary value is overwritten.
      const moved = { ...activeItem, quadrant: overContainer, sort_order: insertIdx };
      if (destList.length === 0) {
        next.push(moved);
        return next;
      }
      const predecessor = insertIdx > 0 ? destList[insertIdx - 1] : null;
      if (predecessor) {
        const predIdx = next.findIndex((t) => t.id === predecessor.id);
        if (predIdx === -1) {
          // Defensive: predecessor disappeared between filter and
          // find. Fall back to the first destination row.
          next.push(moved);
          return next;
        }
        next.splice(predIdx + 1, 0, moved);
      } else {
        // insertIdx === 0: anchor on the first destination row and
        // insert before it.
        const firstDestId = destList[0].id;
        const firstDestIdx = next.findIndex((t) => t.id === firstDestId);
        if (firstDestIdx === -1) {
          next.push(moved);
          return next;
        }
        next.splice(firstDestIdx, 0, moved);
      }
      return next;
    });

    // Hold the layout-shift frame so the next dragover tick keeps
    // returning the cached id even if dnd-kit's rect math lags.
    recentlyMovedToNewContainerRef.current = true;
    requestAnimationFrame(() => {
      recentlyMovedToNewContainerRef.current = false;
    });
    lastOverIdRef.current = overId;
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    lastOverIdRef.current = null;
    recentlyMovedToNewContainerRef.current = false;
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;

    // Calendar reschedule path. The dragged dot's id is prefixed
    // `task:` and the day's droppable id is prefixed `day:` (both
    // exported from Calendar.tsx). On a successful drop we update
    // `due_date` for the task via the hook's setDueDate helper — a
    // single updateTask call, so no live-mirror snapshot/rollback is
    // needed; the realtime channel will eventually replace our state
    // with the server's truth regardless of success/failure.
    if (activeId.startsWith(CALENDAR_TASK_ID_PREFIX)) {
      dragSourceQuadrantRef.current = null;
      if (!overId || !overId.startsWith(CALENDAR_DAY_ID_PREFIX)) return;
      const taskId = decodeCalendarTaskId(activeId);
      const newDate = decodeCalendarDayId(overId);
      const ok = await setDueDate(taskId, newDate);
      if (!ok) toast.showError("Couldn't reschedule the task. Try again.");
      return;
    }

    if (!overId) {
      // No drop target — cancel by restoring the snapshot. Use
      // restoreLiveTasks (it also clears the snapshot ref so the
      // mirror effect resumes seeding from `tasks`).
      dragSourceQuadrantRef.current = null;
      restoreLiveTasks();
      return;
    }
    const ok = await reorder(activeId, overId, dragSourceQuadrantRef.current ?? undefined);
    dragSourceQuadrantRef.current = null;
    // Whether the RPC succeeded or failed, the snapshot is consumed
    // — the hook either committed (snapshot is now stale) or rolled
    // back (liveTasks restored, snapshot discarded). Clearing
    // explicitly so subsequent realtime-driven reseeds resume.
    clearLiveTasksSnapshot();
    if (!ok) {
      // The hook already surfaces a toast via `surface()` for the
      // rollback path. The `applyMove` null-result case (stale drop)
      // doesn't surface anything because it's not user-actionable;
      // we add a soft message here as a belt-and-braces.
      toast.showError("Couldn't save the new order. Try again.");
    }
  }

  function handleDragCancel(e: DragCancelEvent) {
    const activeId = String(e.active.id);
    setActiveDragId(null);
    lastOverIdRef.current = null;
    recentlyMovedToNewContainerRef.current = false;
    dragSourceQuadrantRef.current = null;
    // Calendar drags never took a snapshot, so there is nothing to
    // restore. Bail before the restoreLiveTasks() call so we don't
    // accidentally clobber the matrix mirror when the user cancels
    // a calendar dot drag.
    if (activeId.startsWith(CALENDAR_TASK_ID_PREFIX)) return;
    restoreLiveTasks();
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      setEditing(null);
      setSettingsOpen(false);
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  }

  // Active tab: open tasks grouped by quadrant, sorted by sort_order
  // asc (created_at desc as tiebreaker for null rows). Done tab:
  // completed tasks only, sorted by completed_at desc — most
  // recently finished first.
  //
  // `liveGroups` is the live-mirror bucket — what the matrix grid
  // renders during a drag. `tasks` is the canonical array; we
  // compute `grouped.groups` from it for the *count* tabs (so the
  // badge doesn't flicker while a drag is in flight) and for the
  // Done list (the live mirror doesn't surface completed tasks).
  const grouped = useMemo(() => {
    const active = tasks.filter((t) => !t.completed_at);
    const done = tasks.filter((t) => !!t.completed_at);

    const groups: Record<QuadrantId, Task[]> = {
      do_first: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };
    for (const t of active) groups[t.quadrant].push(t);
    for (const q of Object.keys(groups) as QuadrantId[]) {
      groups[q].sort(taskSort);
    }

    const doneSorted = [...done].sort((a, b) => {
      const aT = a.completed_at ?? '';
      const bT = b.completed_at ?? '';
      return bT.localeCompare(aT);
    });

    return { groups, done: doneSorted };
  }, [tasks]);

  const activeCount =
    grouped.groups.do_first.length +
    grouped.groups.schedule.length +
    grouped.groups.delegate.length +
    grouped.groups.eliminate.length;
  const doneCount = grouped.done.length;

  function handleAdd(quadrant: QuadrantId) {
    setEditing({ kind: 'create', quadrant });
  }

  // Click on a calendar cell → open the create modal with that day
  // pre-filled. The TaskModal reads `initial.due_date` and seeds the
  // form (no need to also default the quadrant — the user picked
  // do_first on creation and can change it from the modal).
  function handleAddOnDate(isoDate: string) {
    setEditing({ kind: 'create', quadrant: 'do_first', dueDate: isoDate });
  }

  function handleEdit(task: Task) {
    setEditing({ kind: 'edit', task });
  }

  function handleToggleComplete(task: Task) {
    if (task.completed_at) uncompleteTask(task.id);
    else completeTask(task.id);
  }

  async function handleCreateSubject(name: string, color: string) {
    return await addSubject({ name, color });
  }

  async function handleSave(data: {
    title: string;
    description: string | null;
    subject_id: string | null;
    due_date: string | null;
    quadrant: QuadrantId;
  }) {
    if (!editing) return;
    if (editing.kind === 'create') {
      await createTask(data);
    } else {
      await updateTask(editing.task.id, data);
    }
    setEditing(null);
  }

  async function handleDelete() {
    if (editing?.kind !== 'edit') return;
    const ok = await confirm({
      title: 'Delete task?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    void deleteTask(editing.task.id).catch(() => {});
    setEditing(null);
  }

  async function handleDeleteTaskFromCard(task: Task) {
    const ok = await confirm({
      title: `Delete "${task.title}"?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    void deleteTask(task.id).catch(() => {});
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="brand">
          <div className="brand-mark">A</div>
          <span>Acme</span>
        </div>
        <div className="dashboard-user">
          <span className="dashboard-display-name">
            {isAnonymous
              ? 'Guest'
              : userDisplayUsername ?? userUsername ?? userEmail}
          </span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button
            type="button"
            className="header-icon-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button type="button" className="btn-secondary" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div className="dashboard-toolbar">
        <h1>Eisenhower Matrix</h1>
        <div className="view-toggle" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'active'}
            className={`view-tab${view === 'active' ? ' is-active' : ''}`}
            onClick={() => setView('active')}
          >
            Active <span className="view-count">{activeCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'done'}
            className={`view-tab${view === 'done' ? ' is-active' : ''}`}
            onClick={() => setView('done')}
          >
            Done <span className="view-count">{doneCount}</span>
          </button>
        </div>
      </div>

      {error && (
        <p className="dashboard-error" role="alert">
          {error}
        </p>
      )}

      {isAnonymous && (
        // One-line reminder that this session has no email/password
        // attached. Tapping the link opens Settings where the user
        // can attach credentials. Kept terse — the upgrade affordance
        // is duplicated in the Settings modal so the user sees it
        // whenever they're investigating their account.
        <div className="dashboard-guest-banner" role="status">
          <span>
            You're browsing as a guest. Your tasks save to this browser only.{' '}
            <button
              type="button"
              className="inline-link"
              onClick={() => setSettingsOpen(true)}
            >
              Add an email and password
            </button>{' '}
            to keep them across devices.
          </span>
        </div>
      )}

      {view === 'active' ? (
        <div className="dashboard-view" key="active">
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="matrix-grid matrix-grid--enter">
              {QUADRANTS.map((q) => (
                <Quadrant
                  key={q.id}
                  id={q.id}
                  tasks={grouped.groups[q.id]}
                  liveTasks={liveGroups[q.id]}
                  subjects={subjects}
                  onAdd={handleAdd}
                  onToggleComplete={handleToggleComplete}
                  onTaskClick={handleEdit}
                  onDelete={handleDeleteTaskFromCard}
                  isTaskBusy={isTaskBusy}
                  // Disable drag for every card in every quadrant
                  // while a reorder RPC is mid-flight. This is the
                  // user-facing guard against racing two drops; the
                  // hook also guards internally.
                  reorderDisabled={reorderBusy}
                />
              ))}
            </div>
            <Calendar
              tasks={tasks}
              onTaskClick={handleEdit}
              onAddOnDate={handleAddOnDate}
            />
            <DragOverlay>
              {activeDragId ? (
                <div className="drag-overlay">
                  {(() => {
                    // Look up the dragged task in the live mirror so
                    // the overlay reflects the in-flight quadrant if
                    // the user has already re-bucketed via onDragOver.
                    // Falls back to the canonical group, then null if
                    // the task has been removed mid-drag.
                    const liveFound = liveTasks.find((t) => t.id === activeDragId);
                    if (liveFound) {
                      return (
                        <TaskCard
                          task={liveFound}
                          subject={subjects.find((s) => s.id === liveFound.subject_id)}
                          onToggleComplete={() => {}}
                          onClick={() => {}}
                          onDelete={() => {}}
                          isBusy={false}
                        />
                      );
                    }
                    for (const q of QUADRANTS) {
                      const found = grouped.groups[q.id].find((t) => t.id === activeDragId);
                      if (found) {
                        return (
                          <TaskCard
                            task={found}
                            subject={subjects.find((s) => s.id === found.subject_id)}
                            onToggleComplete={() => {}}
                            onClick={() => {}}
                            onDelete={() => {}}
                            isBusy={false}
                          />
                        );
                      }
                    }
                    return null;
                  })()}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      ) : (
        <div className="dashboard-view" key="done">
          <DoneList
            tasks={grouped.done}
            subjects={subjects}
            onToggleComplete={handleToggleComplete}
            onTaskClick={handleEdit}
            onDelete={handleDeleteTaskFromCard}
            loading={loading}
            isTaskBusy={isTaskBusy}
          />
        </div>
      )}

      {editing?.kind === 'create' && (
        <TaskModal
          mode="create"
          initial={{
            quadrant: editing.quadrant,
            ...(editing.dueDate ? { due_date: editing.dueDate } : {}),
          }}
          subjects={subjects}
          onCreateSubject={handleCreateSubject}
          onDeleteSubject={deleteSubject}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          isSubjectBusy={isSubjectBusy}
        />
      )}

      {editing?.kind === 'edit' && (
        <TaskModal
          mode="edit"
          initial={{
            id: editing.task.id,
            title: editing.task.title,
            description: editing.task.description,
            subject_id: editing.task.subject_id,
            due_date: editing.task.due_date,
            quadrant: editing.task.quadrant,
          }}
          subjects={subjects}
          onCreateSubject={handleCreateSubject}
          onDeleteSubject={deleteSubject}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          onDelete={handleDelete}
          isSubjectBusy={isSubjectBusy}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          userId={userId}
          userEmail={userEmail}
          currentUsername={userUsername}
          currentDisplayUsername={userDisplayUsername}
          isAnonymous={isAnonymous}
          onClose={() => setSettingsOpen(false)}
          onUsernameUpdated={onUsernameUpdated}
          onAccountDeleted={onAccountDeleted}
          onAccountUpgraded={onAccountUpgraded}
        />
      )}
    </div>
  );
}

// Sort: sort_order ascending when present, created_at desc as the
// tiebreaker for null rows. Matches the contract on Task.sort_order
// in src/types.ts — see the docblock there. The previous due-date
// sort was a per-user preference; the user removed the toggle, so
// drag-driven order is now the source of truth.
function taskSort(a: Task, b: Task) {
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

interface DoneListProps {
  tasks: Task[];
  subjects: Subject[];
  onToggleComplete: (task: Task) => void;
  onTaskClick: (task: Task) => void;
  onDelete: (task: Task) => void;
  loading: boolean;
  isTaskBusy?: (taskId: string) => boolean;
}

function DoneList({ tasks, subjects, onToggleComplete, onTaskClick, onDelete, loading, isTaskBusy }: DoneListProps) {
  if (loading) return <p className="dashboard-status">Loading…</p>;
  if (tasks.length === 0) {
    return (
      <div className="done-empty done-empty--enter">
        <p>No completed tasks yet.</p>
        <p className="muted">Mark a task done in the Active view and it will show up here.</p>
      </div>
    );
  }

  return (
    <div className="done-list done-list--enter">
      <ul className="task-list">
        {tasks.map((task) => {
          const subject = subjects.find((s) => s.id === task.subject_id);
          return (
            <TaskCard
              key={task.id}
              task={task}
              subject={subject}
              onToggleComplete={() => onToggleComplete(task)}
              onClick={() => onTaskClick(task)}
              onDelete={() => onDelete(task)}
              isBusy={isTaskBusy?.(task.id) ?? false}
            />
          );
        })}
      </ul>
    </div>
  );
}