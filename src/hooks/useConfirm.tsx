import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';

// ---------------------------------------------------------------------------
// useConfirm — promise-based confirm dialog hook.
//
// Replaces window.confirm() with a real React modal so the call works in
// any environment (Dia's panel, mobile webviews, embedded iframes) and
// matches the rest of the dashboard's liquid-glass styling.
//
// Usage:
//   const confirm = useConfirm();
//   const ok = await confirm({
//     title: 'Delete task?',
//     message: 'This cannot be undone.',
//     confirmLabel: 'Delete',
//     danger: true,
//   });
//   if (!ok) return;
//
// Concurrent calls are queued: each request gets a Promise, and the
// dialog walks through the queue one at a time.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Text for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Text for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When true, the confirm button uses the destructive style. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  // Active dialog. State drives the render; the ref lets `confirm`
  // synchronously check whether the queue should be advanced without
  // waiting for React to commit a state update.
  const [active, setActive] = useState<PendingConfirm | null>(null);
  const activeRef = useRef<PendingConfirm | null>(null);
  // FIFO queue. Lives in a ref (not state) so we can mutate it
  // synchronously inside `confirm` without forcing a render. The
  // `advance()` helper moves the head into `active` and triggers the
  // re-render that shows the dialog.
  const queueRef = useRef<PendingConfirm[]>([]);

  // Promote the head of the queue into `active`. Called whenever the
  // queue might have grown (after a `confirm` call) or after the
  // current dialog resolved.
  const advance = useCallback(() => {
    if (activeRef.current) return;
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        queueRef.current.push({ ...opts, resolve });
        advance();
      });
    },
    [advance],
  );

  const handleResolve = useCallback(
    (ok: boolean) => {
      // Capture-and-resolve outside the state updater so we never run
      // a side effect during reconciliation (StrictMode replays
      // updaters, which would call resolve() twice).
      const current = activeRef.current;
      activeRef.current = null;
      setActive(null);
      current?.resolve(ok);
      // Promote the next dialog, if any.
      advance();
    },
    [advance],
  );

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {active && (
        <ConfirmDialog
          title={active.title}
          message={active.message}
          confirmLabel={active.confirmLabel}
          cancelLabel={active.cancelLabel}
          danger={active.danger}
          onResolve={handleResolve}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside a <ConfirmProvider>');
  }
  return ctx.confirm;
}
