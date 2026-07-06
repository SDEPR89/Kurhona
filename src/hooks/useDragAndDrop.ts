import { useCallback, useMemo, useRef, useState } from 'react';
import {
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
import type {
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  DragCancelEvent,
} from '@dnd-kit/core';
import type { Quadrant, Task } from '../types';
import { taskSort } from '../lib/taskSort';
import {
  CALENDAR_DAY_ID_PREFIX,
  decodeCalendarDayId,
  decodeCalendarTaskId,
  getEffectiveOverId,
  isCalendarTaskId,
  isEmptyQuadrantId,
  isQuadrantId,
  quadrantIdFromDroppable,
} from '../lib/dragIds';

// Pixels of effective hit-area padding around an empty quadrant's
// <ul>. The empty list's measured rect is the dashed-border box
// itself, so without this boost the dragged card (which only moves
// past the 8px activation distance and thus still overlaps its
// source rect) would need to translate *into* the empty box to
// register a collision. 24px matches the visual breathing room
// around the dashed border so the user's mental model ("I'm
// hovering the empty box → it should accept the drop") maps to the
// actual hit area.
const EMPTY_QUADRANT_HIT_PADDING = 24;

export interface UseDragAndDropInputs {
  /** Live mirror. dnd-kit drives its re-bucketing via `setLiveTasks`
   * during a cross-container move. */
  liveTasks: Task[];
  setLiveTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  /** Snapshot helpers from useTasks. `snapshotLiveTasks` arms the
   * snapshot on dragstart; `restoreLiveTasks` clears the snapshot
   * and reseeds the mirror on cancel/no-target;
   * `clearLiveTasksSnapshot` clears the snapshot on a successful
   * reorder (the snapshot is now stale). The useTasks reseed effect
   * skips while a snapshot is armed so realtime events don't clobber
   * in-flight reordering. */
  snapshotLiveTasks: () => void;
  restoreLiveTasks: () => void;
  clearLiveTasksSnapshot: () => void;
  /** Commit handler from useTasks.reorder. */
  reorder: (
    activeId: string,
    overId: string,
    sourceQuadrant?: Quadrant,
  ) => Promise<boolean>;
  /** Calendar reschedule. Single updateTask call wrapped by runBusy. */
  setDueDate: (id: string, dueDate: string | null) => Promise<Task | null>;
  /** Error / status surface (e.g. `useToast().showError`). */
  surface: (message: string) => void;
}

export interface UseDragAndDropResult {
  /** dnd-kit sensors array — pass straight into <DndContext>. */
  sensors: ReturnType<typeof useSensors>;
  /** Custom 3-tier collision strategy with empty-quadrant boost. */
  collisionDetection: CollisionDetection;
  handleDragStart: (e: DragStartEvent) => void;
  handleDragOver: (e: DragOverEvent) => void;
  handleDragEnd: (e: DragEndEvent) => Promise<void>;
  handleDragCancel: (e: DragCancelEvent) => void;
  /** id of the task currently being dragged, or null. Drives the
   * <DragOverlay>'s contents. */
  activeDragId: string | null;
  /** `tasks` bucketed by quadrant + sorted. Drives the matrix grid
   * during a drag. */
  liveGroups: Record<Quadrant, Task[]>;
  /** True when a drag is in flight. */
  isDragging: boolean;
}

// ---------------------------------------------------------------------------
// useDragAndDrop — owns the matrix + calendar drag-and-drop machinery.
//
// The matrix uses `@dnd-kit/core` with three concerns:
//   1. The live-mirror pattern (liveTasks drifts from `tasks` during a
//      drag so dnd-kit's transform math keeps working across
//      containers).
//   2. A custom 3-tier collision strategy with an empty-quadrant
//      boost so the user can drop into an empty quadrant without
//      translating the dragged card over the dashed border first.
//   3. A <DragOverlay> anchored to the cursor via snapCenterToCursor.
//
// This hook owns all three concerns plus the refs that bridge
// dnd-kit's tick-by-tick handlers. The dashboard component just
// wires the returned values into <DndContext> + <DragOverlay>.
//
// Calendar drags (id prefix `task:`) bypass the matrix machinery
// entirely and route to setDueDate on drop; their handling is
// isolated inside the same hook so the dashboard doesn't need to
// install a second <DndContext>.
// ---------------------------------------------------------------------------
export function useDragAndDrop(inputs: UseDragAndDropInputs): UseDragAndDropResult {
  const {
    liveTasks,
    setLiveTasks,
    snapshotLiveTasks,
    restoreLiveTasks,
    clearLiveTasksSnapshot,
    reorder,
    setDueDate,
    surface,
  } = inputs;

  const sensors = useSensors(
    // 8px activation distance so stationary clicks on the card body
    // still reach the inner button (and the checkbox / delete ×).
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // Keyboard sensor for accessibility (Tab → Space → arrows → Space).
    useSensor(KeyboardSensor),
  );

  // Bucket the live mirror by quadrant. While a drag is in flight
  // this reflects the in-flight reordering; otherwise it mirrors
  // `tasks` exactly.
  const liveGroups = useMemo<Record<Quadrant, Task[]>>(() => {
    const groups: Record<Quadrant, Task[]> = {
      do_first: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };
    for (const t of liveTasks) {
      if (!t.completed_at && (t.task_type ?? 'homework') === 'homework') groups[t.quadrant].push(t);
    }
    for (const q of Object.keys(groups) as Quadrant[]) {
      groups[q].sort(taskSort);
    }
    return groups;
  }, [liveTasks]);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Cached drop target from the most recent dragover tick. After a
  // cross-container move (onDragOver changes the dragged card's
  // quadrant), dnd-kit briefly reports `over` as null while the
  // layout shifts; reusing the cached id keeps the collision chain
  // alive across that frame.
  const lastOverIdRef = useRef<string | null>(null);
  // Original source quadrant of the active drag, captured on
  // dragstart. By the time onDragEnd fires the live mirror has
  // already re-bucketed the dragged card into the destination, so
  // `active.quadrant` is no longer the true source. We pass this
  // value to `reorder` so `applyMove` computes the cross-quadrant
  // move correctly.
  const dragSourceQuadrantRef = useRef<Quadrant | null>(null);
  // Flag set right after we re-bucket the dragged card into a new
  // container so the next dragover tick can fall back to the cached
  // id when dnd-kit's pointer math hasn't caught up. Cleared on the
  // next animation frame.
  const recentlyMovedToNewContainerRef = useRef(false);

  const collisionDetection: CollisionDetection = useCallback((args) => {
    // Hold the previous target so the drag doesn't appear to drop
    // when dnd-kit's pointer math briefly reports no collision
    // after a cross-container move.
    if (recentlyMovedToNewContainerRef.current && lastOverIdRef.current) {
      return [{ id: lastOverIdRef.current }];
    }

    // 1) Empty-quadrant boost. Walk droppableContainers once and
    //    synthesize an inflated rect for any 'empty-quadrant'
    //    droppable. If the cursor falls inside the inflated rect,
    //    return that droppable immediately.
    const pointer = args.pointerCoordinates;
    if (pointer) {
      for (const container of args.droppableContainers) {
        if (container.data.current?.kind !== 'empty-quadrant') continue;
        const rect = args.droppableRects.get(container.id);
        if (!rect) continue;
        const pad = EMPTY_QUADRANT_HIT_PADDING;
        const inflated = {
          top: rect.top - pad,
          left: rect.left - pad,
          right: rect.right + pad,
          bottom: rect.bottom + pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        };
        if (
          pointer.x >= inflated.left &&
          pointer.x <= inflated.right &&
          pointer.y >= inflated.top &&
          pointer.y <= inflated.bottom
        ) {
          // Return the actual registered id (`empty:<id>`), not the
          // canonical `quadrant:<id>`. dnd-kit looks up the
          // droppable container by the id it received from
          // useDroppable; the canonical id isn't registered in the
          // empty case (only `empty:<id>` is). The canonical form
          // is recovered downstream via getEffectiveOverId.
          const id = String(container.id);
          lastOverIdRef.current = getEffectiveOverId(id);
          return [{ id }];
        }
      }
    }

    // Rebuild args with collisionRect centered on the pointer so
    // rectIntersection / closestCenter see where the user actually
    // sees the overlay (re-centered via snapCenterToCursor).
    const baseArgs =
      pointer && args.collisionRect
        ? {
            ...args,
            collisionRect: {
              top: pointer.y - args.collisionRect.height / 2,
              left: pointer.x - args.collisionRect.width / 2,
              right: pointer.x + args.collisionRect.width / 2,
              bottom: pointer.y + args.collisionRect.height / 2,
              width: args.collisionRect.width,
              height: args.collisionRect.height,
            },
          }
        : args;

    // 2) Pointer-direct (highest fidelity).
    const pointerHits = pointerWithin(args);
    if (pointerHits.length > 0) {
      const id = String(pointerHits[0].id);
      lastOverIdRef.current = getEffectiveOverId(id);
      return [{ id }];
    }

    // 3) Rect intersection (catches the border of the empty <ul>
    // and the append strip).
    const rectHits = rectIntersection(baseArgs);
    if (rectHits.length > 0) {
      const first = getFirstCollision(rectHits, 'id');
      if (first) {
        const id = String(first);
        lastOverIdRef.current = getEffectiveOverId(id);
        return [{ id }];
      }
    }

    // 4) Closest center (in-list reorder between two cards).
    const centerHits = closestCenter(baseArgs);
    if (centerHits.length > 0) {
      const id = String(centerHits[0].id);
      lastOverIdRef.current = getEffectiveOverId(id);
      return [{ id }];
    }

    // No hit — but if we have a cached id, hold it so the drag
    // doesn't appear to drop in the gap between cards.
    if (lastOverIdRef.current) return [{ id: lastOverIdRef.current }];
    return [];
  }, []);

  // Helper: find the current quadrant of either a quadrant-target
  // id or a task id (looking up in the live mirror so we see the
  // in-flight reordering during a drag).
  const findLiveContainer = (id: string): Quadrant | null => {
    const effective = getEffectiveOverId(id);
    if (isQuadrantId(effective)) return quadrantIdFromDroppable(effective);
    const t = liveTasks.find((x) => x.id === id);
    return t ? t.quadrant : null;
  };

  const handleDragStart = (e: DragStartEvent) => {
    const activeId = String(e.active.id);
    // Calendar drags bypass the live-mirror machinery entirely.
    if (isCalendarTaskId(activeId)) {
      setActiveDragId(activeId);
      lastOverIdRef.current = null;
      dragSourceQuadrantRef.current = null;
      return;
    }
    setActiveDragId(activeId);
    snapshotLiveTasks();
    lastOverIdRef.current = activeId;
    const t = liveTasks.find((x) => x.id === activeId);
    dragSourceQuadrantRef.current = t ? t.quadrant : null;
  };

  // Mid-drag re-bucket. dnd-kit calls onDragOver continuously while
  // the pointer moves; if `over` is in a different container than
  // the active item we move the active item to the new container.
  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;

    const activeId = String(active.id);
    const overId = getEffectiveOverId(String(over.id));
    if (overId === activeId) return;

    // Calendar drags don't need the matrix re-bucket logic.
    if (isCalendarTaskId(activeId)) {
      lastOverIdRef.current = isEmptyQuadrantId(overId) || overId.startsWith(CALENDAR_DAY_ID_PREFIX) ? overId : null;
      return;
    }

    const activeContainer = findLiveContainer(activeId);
    const overContainer = findLiveContainer(overId);
    if (!activeContainer || !overContainer) return;
    if (activeContainer === overContainer) {
      lastOverIdRef.current = overId;
      return;
    }

    // Cross-container move. Insert at the pointer-Y position
    // relative to the hovered card (drop after if dragging
    // downward).
    setLiveTasks((prev) => {
      const activeIdx = prev.findIndex((t) => t.id === activeId);
      if (activeIdx === -1) return prev;
      const activeItem = prev[activeIdx];

      const destList = prev.filter((t) => t.quadrant === overContainer && t.id !== activeId);
      let insertIdx = destList.length;
      if (!isQuadrantId(overId)) {
        const overIdxInDest = destList.findIndex((t) => t.id === overId);
        if (overIdxInDest !== -1) {
          const activeRect = active.rect.current.translated;
          const overRect = over.rect;
          const isBelow =
            activeRect && overRect && activeRect.top > overRect.top + overRect.height / 2;
          insertIdx = isBelow ? overIdxInDest + 1 : overIdxInDest;
        }
      }

      const next = prev.filter((_, i) => i !== activeIdx);
      const moved = { ...activeItem, quadrant: overContainer, sort_order: insertIdx };
      if (destList.length === 0) {
        next.push(moved);
        return next;
      }
      const predecessor = insertIdx > 0 ? destList[insertIdx - 1] : null;
      if (predecessor) {
        const predIdx = next.findIndex((t) => t.id === predecessor.id);
        if (predIdx === -1) {
          next.push(moved);
          return next;
        }
        next.splice(predIdx + 1, 0, moved);
      } else {
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

    recentlyMovedToNewContainerRef.current = true;
    requestAnimationFrame(() => {
      recentlyMovedToNewContainerRef.current = false;
    });
    lastOverIdRef.current = overId;
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveDragId(null);
    lastOverIdRef.current = null;
    recentlyMovedToNewContainerRef.current = false;
    const activeId = String(e.active.id);
    const overId = e.over ? getEffectiveOverId(String(e.over.id)) : null;

    // Calendar reschedule path.
    if (isCalendarTaskId(activeId)) {
      dragSourceQuadrantRef.current = null;
      if (!overId || !overId.startsWith(CALENDAR_DAY_ID_PREFIX)) return;
      const taskId = decodeCalendarTaskId(activeId);
      const newDate = decodeCalendarDayId(overId);
      const row = await setDueDate(taskId, newDate);
      if (!row) surface("Couldn't reschedule the task. Try again.");
      return;
    }

    if (!overId) {
      // No drop target — restore the snapshot (which also reseeds
      // the mirror with any rows that arrived via realtime).
      dragSourceQuadrantRef.current = null;
      restoreLiveTasks();
      return;
    }
    await reorder(activeId, overId, dragSourceQuadrantRef.current ?? undefined);
    dragSourceQuadrantRef.current = null;
    // Whether the RPC succeeded or failed, the snapshot is consumed
    // (commit OR rollback).
    clearLiveTasksSnapshot();
  };

  const handleDragCancel = (e: DragCancelEvent) => {
    const activeId = String(e.active.id);
    setActiveDragId(null);
    lastOverIdRef.current = null;
    recentlyMovedToNewContainerRef.current = false;
    dragSourceQuadrantRef.current = null;
    if (isCalendarTaskId(activeId)) return;
    restoreLiveTasks();
  };

  return {
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeDragId,
    liveGroups,
    isDragging: !!activeDragId,
  };
}
