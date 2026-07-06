import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Subject, SubjectInsert } from '../types';

// See useTasks.ts for why showError is injected via options rather than
// pulled from a context inside the hook.
export interface UseSubjectsOptions {
  showError?: (message: string) => void;
}

export function useSubjects(userId: string | null, options: UseSubjectsOptions = {}) {
  const { showError } = options;
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  // Set of subject ids with an in-flight mutation. SubjectSelect
  // consults `isBusy(id)` to disable the × button while a delete is
  // mid-round-trip. Subject creation goes through SubjectManager
  // which has its own local `busy` state on the form, so we don't
  // track creates here.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // The single error surface. Calls the injected `showError` (which
  // in Dashboard sets a local `dashboardError` state) — there is no
  // internal `error` state to keep in sync.
  const surface = useCallback(
    (message: string) => {
      showError?.(message);
    },
    [showError],
  );

  // Add `id` to the busy set before `fn` runs, remove it after — even
  // if fn throws.
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

  useEffect(() => {
    if (!userId) {
      setSubjects([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('subjects')
        .select('*')
        .eq('user_id', userId)
        .order('name', { ascending: true });

      if (cancelled) return;
      if (error) {
        surface("Couldn't load your subjects.");
      } else {
        setSubjects((data ?? []) as Subject[]);
      }
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel(`subjects:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'subjects', filter: `user_id=eq.${userId}` },
        (payload) => {
          setSubjects((prev) => {
            if (payload.eventType === 'INSERT') {
              const row = payload.new as Subject;
              return prev.some((s) => s.id === row.id) ? prev : [...prev, row].sort(byName);
            }
            if (payload.eventType === 'UPDATE') {
              const row = payload.new as Subject;
              return prev.map((s) => (s.id === row.id ? row : s)).sort(byName);
            }
            if (payload.eventType === 'DELETE') {
              const old = payload.old as { id: string };
              return prev.filter((s) => s.id !== old.id);
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

  const addSubject = useCallback(
    async (insert: SubjectInsert): Promise<Subject | null> => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from('subjects')
        .insert({ ...insert, user_id: userId })
        .select()
        .single();
      if (error) {
        surface("Couldn't add the subject.");
        return null;
      }
      return (data ?? null) as Subject | null;
    },
    [userId, surface],
  );

  // Optimistic delete: drop the row from local state immediately so the
  // UI doesn't have to wait for the round-trip. If Supabase rejects the
  // delete, re-fetch to put the row back. The realtime DELETE channel
  // handler is also watching for deletes, so even without the optimistic
  // update the row would eventually disappear — but the optimistic path
  // makes the click feel instant.
  const deleteSubject = useCallback(
    async (id: string): Promise<boolean> => {
      return runBusy(id, async () => {
        if (!userId) return false;
        setSubjects((prev) => prev.filter((s) => s.id !== id));
        const { error } = await supabase.from('subjects').delete().eq('id', id);
        if (error) {
          // Roll back the optimistic remove by re-syncing from the server.
          const { data } = await supabase
            .from('subjects')
            .select('*')
            .eq('user_id', userId)
            .order('name', { ascending: true });
          if (data) setSubjects((data ?? []) as Subject[]);
          surface("Couldn't delete the subject. Try again.");
          return false;
        }
        return true;
      });
    },
    [userId, runBusy, surface],
  );

  return { subjects, loading, addSubject, deleteSubject, isBusy };
}

function byName(a: Subject, b: Subject) {
  return a.name.localeCompare(b.name);
}