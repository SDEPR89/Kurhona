import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { applyMove, snapshotMove } from '../lib/reorder';
import type { Task, TaskInsert, Quadrant } from '../types';

// Hook options. `showError` is injected from the component that calls
// this hook (e.g. Dashboard via `useToast().showError`). Keeping the
// hook decoupled from the toast context means it stays testable and
// reusable — tests can pass a no-op or a recorder.
export interface UseTasksOptions {
  showError?: (message: string) => void;
}

export function useTasks(userId: string | null, options: UseTasksOptions = {}) {
  const { showError } = options;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Set of task ids with an in-flight mutation. Components like
  // TaskCard consult `isBusy(id)` to disable the × button and the
  // complete checkbox while an operation is mid-round-trip, preventing
  // a fast double-click from racing two requests to the server. The
  // set is small in practice (0–2 ids during normal use); copying it
  // on each update is cheaper than diffing an array.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Single flag for drag-and-drop persistence. Distinct from `busyIds`
  // because no single task is "busy" during a drop — the whole move is
  // one unit (1–2 RPCs) and the dashboard uses this flag to disable
  // further drags while a write is in flight.
  const [reorderBusy, setReorderBusy] = useState(false);
  // Live mirror of `tasks` used as the drag-and-drop source of truth.
  // dnd-kit mutates this in `onDragOver` so a card can move across
  // quadrant containers mid-drag (each quadrant's <SortableContext>
  // reads its items from here). The canonical `tasks` array is still
  // driven by realtime + RPC responses; this mirror is reseeded on
  // every `tasks` change via the effect below. Components outside the
  // active drag (Done view, counts) keep reading `tasks` directly so
  // server-side updates show immediately without waiting for the
  // mirror to settle.
  const [liveTasks, setLiveTasks] = useState<Task[]>([]);
  // Snapshot of `liveTasks` taken at dragstart, restored on
  // dragcancel or on a server-side reorder failure. Survives across
  // renders via a ref because we never want it to drive a re-render.
  const liveTasksSnapshotRef = useRef<Task[] | null>(null);

  // Stable wrapper that records to BOTH the banner state (for the
  // load-error case) and the toast (for write failures). The banner is
  // intentionally kept for backward compatibility — see the dashboard
  // .dashboard-error usage — even though it only reliably shows for
  // load errors.
  const surface = useCallback(
    (message: string) => {
      setError(message);
      showError?.(message);
    },
    [showError],
  );

  // Add `id` to the busy set before `fn` runs, remove it after — even
  // if fn throws. The rethrow lets callers still see the error
  // (e.g. deleteTask relies on throwing so the caller can choose to
  // .catch or fire-and-forget).
  const runBusy = useCallback(async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      return await fn();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const isBusy = useCallback((id: string) => busyIds.has(id), [busyIds]);

  // Ref that mirrors the latest `tasks`. We use this in `reorder` to
  // build a snapshot at call time (not closure-captured) so two
  // back-to-back drops see consistent state.
  const tasksRef = useRef<Task[]>(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // Reseed the live mirror from the canonical task list. Skips the
  // update while a drag is in flight (we set the snapshot ref on
  // dragstart and the mirror diverges from `tasks` until dragend or
  // dragcancel) so a realtime event landing mid-drag doesn't snap the
  // dragged card back to its old position. After dragend the mirror
  // is already aligned with `tasks` by virtue of how `reorder` writes
  // through; realtime events land normally.
  useEffect(() => {
    if (liveTasksSnapshotRef.current !== null) return;
    setLiveTasks(tasks);
  }, [tasks]);

  // Snapshot helpers called by the dashboard's DndContext handlers.
  // Snapshot must be a deep clone so subsequent `setLiveTasks` calls
  // can't mutate the captured state; restore overwrites the live
  // mirror with the snapshot.
  const snapshotLiveTasks = useCallback(() => {
    liveTasksSnapshotRef.current = liveTasks.map((t) => ({ ...t }));
  }, [liveTasks]);
  const restoreLiveTasks = useCallback(() => {
    const snap = liveTasksSnapshotRef.current;
    liveTasksSnapshotRef.current = null;
    if (snap) setLiveTasks(snap);
  }, []);
  const clearLiveTasksSnapshot = useCallback(() => {
    liveTasksSnapshotRef.current = null;
  }, []);

  useEffect(() => {
    if (!userId) {
      setTasks([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (error) {
        // Translate the technical Supabase error into something the
        // user can act on. Network errors reach this branch too.
        surface("Couldn't load your tasks. Refresh to try again.");
      } else {
        setTasks((data ?? []) as Task[]);
      }
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel(`tasks:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` },
        (payload) => {
          setTasks((prev) => {
            if (payload.eventType === 'INSERT') {
              const row = payload.new as Task;
              return prev.some((t) => t.id === row.id) ? prev : [row, ...prev];
            }
            if (payload.eventType === 'UPDATE') {
              const row = payload.new as Task;
              return prev.map((t) => (t.id === row.id ? row : t));
            }
            if (payload.eventType === 'DELETE') {
              const old = payload.old as { id: string };
              return prev.filter((t) => t.id !== old.id);
            }
            return prev;
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, surface]);

  const createTask = useCallback(
    async (insert: TaskInsert): Promise<Task | null> => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from('tasks')
        .insert({ ...insert, user_id: userId })
        .select()
        .single();
      if (error) {
        surface("Couldn't save the task. Check your connection and try again.");
        return null;
      }
      const row = (data ?? null) as Task | null;
      // Optimistic local insert — drop the row into both the canonical
      // array and the live mirror immediately so the calendar (and any
      // other consumer) renders without waiting for the realtime
      // echo. Realtime INSERT events are idempotent against this entry
      // via the `prev.some(...)` dedup at the postgres_changes
      // handler. Doing this in both arrays keeps the matrix and
      // calendar in sync even if realtime briefly lags.
      if (row) {
        setTasks((prev) => (prev.some((t) => t.id === row.id) ? prev : [row, ...prev]));
        setLiveTasks((prev) => (prev.some((t) => t.id === row.id) ? prev : [row, ...prev]));
      }
      return row;
    },
    [userId, surface],
  );

  const updateTask = useCallback(
    async (id: string, patch: Partial<TaskInsert>): Promise<Task | null> => {
      return runBusy(id, async () => {
        const { data, error } = await supabase
          .from('tasks')
          .update(patch)
          .eq('id', id)
          .select()
          .single();
        if (error) {
          surface("Couldn't save changes to this task.");
          return null;
        }
        return (data ?? null) as Task | null;
      });
    },
    [runBusy, surface],
  );

  const setQuadrant = useCallback(
    async (id: string, quadrant: Quadrant) => updateTask(id, { quadrant }),
    [updateTask],
  );

  // Calendar reschedule — moves a task to a new due date (or clears it
  // when passed `null`). Same shape as setQuadrant so the calendar's
  // drag-and-drop handler can treat both symmetrically.
  const setDueDate = useCallback(
    async (id: string, dueDate: string | null) => updateTask(id, { due_date: dueDate }),
    [updateTask],
  );

  const completeTask = useCallback(
    async (id: string) => {
      await runBusy(id, async () => {
        const { error } = await supabase
          .from('tasks')
          .update({ completed_at: new Date().toISOString() })
          .eq('id', id);
        if (error) surface("Couldn't update the task status.");
      });
    },
    [runBusy, surface],
  );

  const uncompleteTask = useCallback(async (id: string) => {
    await runBusy(id, async () => {
      const { error } = await supabase
        .from('tasks')
        .update({ completed_at: null })
        .eq('id', id);
      if (error) surface("Couldn't update the task status.");
    });
  }, [runBusy, surface]);

  const deleteTask = useCallback(
    async (id: string) => {
      await runBusy(id, async () => {
        if (!userId) {
          const msg = 'Not signed in';
          surface(msg);
          throw new Error(msg);
        }
        // Optimistic local removal — drop the row from state immediately so the
        // UI updates without waiting for the realtime event. We keep a snapshot
        // so we can restore if the server rejects the delete.
        let snapshot: Task | undefined;
        setTasks((prev) => {
          snapshot = prev.find((t) => t.id === id);
          return prev.filter((t) => t.id !== id);
        });

        // The `user_id` filter is what actually targets the row — RLS alone
        // silently filters out deletes, so the row stays in the DB without it.
        const { error } = await supabase.from('tasks').delete().eq('id', id).eq('user_id', userId);
        if (error) {
          // Restore the task we optimistically removed.
          if (snapshot) {
            setTasks((prev) => (prev.some((t) => t.id === id) ? prev : [snapshot!, ...prev]));
          }
          surface("Couldn't delete the task. Restoring it now.");
          throw error;
        }
      });
    },
    [userId, runBusy, surface],
  );

  // Drag-and-drop reorder. Pure compute happens in `applyMove`; we
  // apply the result optimistically, then call `reorder_tasks` RPC
  // once per affected quadrant (1 RPC for within-quadrant, 2 for
  // cross-quadrant). The RPC also writes `quadrant = p_quadrant` for
  // every id, so the cross-quadrant case doesn't need a separate
  // updateTask call.
  //
  // On any RPC error we restore the snapshot and surface a toast. The
  // realtime UPDATE events emitted for each row we just wrote are
  // naturally idempotent — the local row already matches the
  // incoming payload, so `prev.map(t => t.id === row.id ? row : t)`
  // is a no-op for our own writes.
  //
  // We read from `liveTasksRef` rather than `tasksRef` because the
  // dashboard has been re-bucketing the dragged card via setLiveTasks
  // during the drag — `tasks` is stale by that point. We also write
  // the optimistic apply through `setLiveTasks` so the UI stays
  // consistent with what the user saw during the drag, then mirror
  // the same change into `setTasks` so the canonical array stays in
  // sync (the realtime echoes that follow the RPC will be no-ops).
  const liveTasksRef = useRef<Task[]>(liveTasks);
  useEffect(() => {
    liveTasksRef.current = liveTasks;
  }, [liveTasks]);

  const reorder = useCallback(
    async (activeId: string, overId: string, sourceQuadrant?: Quadrant): Promise<boolean> => {
      if (!userId) {
        surface("Couldn't reorder — not signed in.");
        return false;
      }
      if (reorderBusy) return false;

      // Compute the move against the freshest live list (the ref
      // tracks the latest mid-drag state set by onDragOver). Pass
      // the original source quadrant if the dashboard captured it on
      // dragstart — `liveTasks` already has the dragged card in the
      // destination by this point, so without the override
      // `applyMove` would treat the move as a within-quadrant
      // reorder and skip rewriting the source bucket.
      const result = applyMove(liveTasksRef.current, activeId, overId, sourceQuadrant);
      if (!result) return false;

      // Build the pre-move snapshot for rollback from the live
      // mirror — `tasks` may be stale because the dashboard has been
      // re-bucketing via setLiveTasks during the drag.
      const snap = snapshotMove(liveTasksRef.current, result);
      const snapMap = new Map(snap.map((s) => [s.quadrant, s.tasks]));

      // Optimistic local apply: rewrite every touched quadrant in
      // BOTH the live mirror and the canonical array. The `byQuadrant`
      // map gives us the complete new list for each affected
      // quadrant (source and destination); untouched quadrants are
      // not in the map and stay as-is.
      const applyOptimistic = (prev: Task[]): Task[] => {
        const next = prev.map((t) => ({ ...t }));
        for (const [q, list] of Object.entries(result.byQuadrant)) {
          if (!list) continue;
          const newIds = new Set(list.map((t) => t.id));
          // Remove rows currently bucketed under this quadrant that
          // aren't in the new list (e.g. the moved card in the source
          // bucket, or pre-apply destination rows that need to be
          // reordered).
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].quadrant === q && !newIds.has(next[i].id)) {
              next.splice(i, 1);
            }
          }
          // Insert / update rows from the new list in order. New
          // rows (the moved card in the destination bucket) get
          // appended; existing rows get their sort_order and
          // quadrant refreshed.
          for (const incoming of list) {
            const idx = next.findIndex((t) => t.id === incoming.id);
            if (idx === -1) {
              next.push(incoming);
            } else {
              next[idx] = incoming;
            }
          }
        }
        return next;
      };
      setLiveTasks(applyOptimistic);
      setTasks(applyOptimistic);

      setReorderBusy(true);
      try {
        // One RPC per touched quadrant. Each handles both
        // sort_order and quadrant columns (the RPC writes
        // quadrant = p_quadrant for every id in p_ids).
        for (const [q, list] of Object.entries(result.byQuadrant)) {
          if (!list || list.length === 0) continue;
          const ids = list.map((t) => t.id);
          const { error } = await supabase.rpc('reorder_tasks', {
            p_user: userId,
            p_quadrant: q,
            p_ids: ids,
          });
          if (error) {
            // Roll back to the snapshot for every touched quadrant
            // in both arrays.
            const rollback = (prev: Task[]): Task[] => {
              const next = prev.map((t) => ({ ...t }));
              for (const [sq, snapList] of snapMap.entries()) {
                const newIds = new Set(snapList.map((t) => t.id));
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].quadrant === sq && !newIds.has(next[i].id)) {
                    next.splice(i, 1);
                  }
                }
                for (const t of snapList) {
                  const idx = next.findIndex((x) => x.id === t.id);
                  if (idx === -1) next.push(t);
                  else next[idx] = t;
                }
              }
              return next;
            };
            setLiveTasks(rollback);
            setTasks(rollback);
            // Surface the server's actual message so the next
            // failure tells us whether it's RLS, the missing
            // function signature, a permission grant, etc.
            // `error.message` is the raw PostgREST / Postgres text.
            const detail = error.message ? `: ${error.message}` : '';
            surface(`Couldn't reorder${detail}. Restoring the previous order.`);
            // Also log to the console for debugging — surface()
            // already toasts, but the console keeps the full
            // error object around for inspection.
            console.error('reorder_tasks RPC failed', { q, ids, error });
            return false;
          }
        }
        return true;
      } finally {
        setReorderBusy(false);
      }
    },
    [userId, reorderBusy, surface],
  );

  return {
    tasks,
    loading,
    error,
    liveTasks,
    setLiveTasks,
    snapshotLiveTasks,
    restoreLiveTasks,
    clearLiveTasksSnapshot,
    createTask,
    updateTask,
    setQuadrant,
    setDueDate,
    completeTask,
    uncompleteTask,
    deleteTask,
    reorder,
    reorderBusy,
    isBusy,
  };
}