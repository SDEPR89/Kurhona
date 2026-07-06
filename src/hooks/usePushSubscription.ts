import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { urlBase64ToUint8Array } from '../lib/pushKey';

// The state machine surfaced to consumers. A user moving from
// `prompt` → `denied` is permanent (the browser locks out further
// permission asks for that origin), so the Settings UI uses
// `denied` as the terminal state to show a "permission blocked"
// message instead of a toggle.
//
// `unsupported-mobile` is a separate branch for iOS Safari tabs:
// `PushManager` exists, but push only works after the user
// installs the PWA. We don't try to subscribe in that case.
export type PushState =
  | 'unsupported'         // no ServiceWorker / PushManager at all
  | 'unsupported-mobile'  // iOS Safari tab (push needs PWA install)
  | 'prompt'              // permission not yet asked — show toggle
  | 'denied'              // user blocked notifications
  | 'subscribed'          // we have a live subscription in Supabase
  | 'error';              // transient failure — see `error` for detail

interface UsePushSubscriptionResult {
  state: PushState;
  error: string | null;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
}

// Detect iOS Safari tab (push only works when installed). Other mobile
// browsers (Chrome on Android, etc.) get normal handling.
function detectIosSafariTab(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isiOS = /iPad|iPhone|iPod/.test(ua);
  const isWebkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  // `'standalone' in navigator` is the standard check for "is the app
  // running as an installed PWA". If true, we're installed and push works.
  // If false, we're a regular tab and push is blocked on iOS Safari.
  const isStandalone =
    (typeof (navigator as Navigator & { standalone?: boolean }).standalone === 'boolean' &&
      (navigator as Navigator & { standalone?: boolean }).standalone) ||
    // The new MediaQuery-style check works in newer Safari and some Android
    // browsers; both should be treated as installed.
    window.matchMedia?.('(display-mode: standalone)').matches;
  return isiOS && isWebkit && !isStandalone;
}

export function usePushSubscription(userId: string | null): UsePushSubscriptionResult {
  const [state, setState] = useState<PushState>('prompt');
  const [error, setError] = useState<string | null>(null);

  // Look up the SW registration and an existing PushSubscription,
  // and cross-check that we've recorded it in Supabase. If the SW
  // has a sub but Supabase doesn't, the user cleared the database
  // or the upsert failed — re-record it.
  const probeExisting = useCallback(async () => {
    if (!userId) {
      setState('prompt');
      return;
    }
    try {
      const perm = Notification.permission; // 'default' | 'granted' | 'denied'
      if (perm === 'denied') {
        setState('denied');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setState('prompt');
        return;
      }
      // Cross-check the DB — the SW may have a sub the DB lost
      // (e.g. table was wiped). Re-upsert in that case.
      const { data } = await supabase
        .from('push_subscriptions')
        .select('endpoint')
        .eq('endpoint', sub.endpoint)
        .maybeSingle();
      if (!data) {
        await persistSubscription(sub, userId);
      }
      setState('subscribed');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  }, [userId]);

  // One-time boot: figure out what the browser supports and what
  // state we're in. Runs when `userId` becomes available (we don't
  // subscribe anonymous users — their data is local-only and the
  // push would be undeliverable anyway).
  useEffect(() => {
    if (!userId) {
      setState('prompt');
      return;
    }
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      setState('unsupported');
      return;
    }
    if (!('PushManager' in window)) {
      setState(detectIosSafariTab() ? 'unsupported-mobile' : 'unsupported');
      return;
    }
    if (detectIosSafariTab()) {
      setState('unsupported-mobile');
      return;
    }
    // We have everything we need. Probe the existing permission +
    // subscription so the UI reflects the truth on first render.
    void probeExisting();
  }, [userId, probeExisting]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!userId) {
      // Caller passed a null user — we don't subscribe anonymous
      // accounts (their data is local-only).
      setState('prompt');
      return false;
    }
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!vapidKey) {
      setError('VAPID public key not configured.');
      setState('error');
      return false;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'denied') {
        setState('denied');
        return false;
      }
      if (perm !== 'granted') {
        setState('prompt');
        return false;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      // Wait for the SW to be active (or already active). Without
      // this, the first subscribe after a fresh install races the
      // `activate` event and can throw.
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }
      await persistSubscription(sub, userId);
      setState('subscribed');
      return true;
    } catch (e) {
      setError((e as Error).message);
      setState('error');
      return false;
    }
  }, [userId]);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
      setState('prompt');
      return true;
    } catch (e) {
      setError((e as Error).message);
      setState('error');
      return false;
    }
  }, []);

  return { state, error, subscribe, unsubscribe };
}

// Persist a PushSubscription to Supabase. Called both on initial
// subscribe and during the probe when the SW has a sub the DB
// doesn't know about.
async function persistSubscription(
  sub: PushSubscription,
  userId: string,
): Promise<void> {
  const json = sub.toJSON();
  const keys = json.keys as { p256dh: string; auth: string };
  // user_id is required by the RLS policy (`user_id = auth.uid()`).
  // The browser doesn't see the auth session, so we have to forward
  // the user id explicitly. The RLS WITH CHECK ensures the value
  // matches the caller's auth.uid() — a user can't write a row
  // under someone else's id.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint: sub.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      },
      { onConflict: 'endpoint' },
    );
  if (error) throw new Error(error.message);
}
