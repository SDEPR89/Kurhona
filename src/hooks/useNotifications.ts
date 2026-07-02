import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Task } from '../types';

// ---------------------------------------------------------------------------
// VAPID public key — must match VAPID_PUBLIC_KEY secret in Supabase Edge Fn.
// This is public and safe to embed in client code.
// ---------------------------------------------------------------------------
const VAPID_PUBLIC_KEY = 'ztzK5iFZPkpl71TxfhaXQE7Zhp9QNSWH4EZzGTd1iOuSzS-XKBNLgd1mKoyC2jbWa1pDIsi0ahjVpZmyR5xlYQ';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  fireAt: number;
}

export interface UseNotificationsReturn {
  isSupported: boolean;
  /** True on iOS Safari outside a PWA — push won't work until added to Home Screen */
  isIosWithoutPwa: boolean;
  permission: NotificationPermission | 'unsupported';
  isEnabled: boolean;
  toggle: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'kurhona_notifications_enabled';

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

function isIos(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /iphone|ipad|ipod/i.test(navigator.userAgent)
  );
}

function isInStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.navigator as any).standalone === true)
  );
}

function checkSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = base64String.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Client-side fallback schedule (fires while app is open via SW setTimeout)
// ---------------------------------------------------------------------------

function buildSchedule(tasks: Task[]): ScheduledNotification[] {
  const now = Date.now();
  const schedule: ScheduledNotification[] = [];

  for (const task of tasks) {
    if (task.completed_at) continue;
    if (task.status === 'submitted') continue;
    if (!task.due_date) continue;

    const [year, month, day] = task.due_date.split('-').map(Number);

    // 3 days before at 7 AM
    const threeDayBefore = new Date(year, month - 1, day - 3, 7, 0, 0).getTime();
    if (threeDayBefore > now) {
      schedule.push({
        id: `${task.id}_3d`,
        title: '⏰ Kurhona Reminder',
        body: `${task.title} is due in 3 days`,
        fireAt: threeDayBefore,
      });
    }

    // 1 day before at 7 AM
    const oneDayBefore = new Date(year, month - 1, day - 1, 7, 0, 0).getTime();
    if (oneDayBefore > now) {
      schedule.push({
        id: `${task.id}_1d`,
        title: '⏰ Kurhona Reminder',
        body: `${task.title} is due tomorrow`,
        fireAt: oneDayBefore,
      });
    }

    // 1 hour before due_time (if set)
    if (task.due_time) {
      const [h, m] = task.due_time.split(':').map(Number);
      const dueWithTime = new Date(year, month - 1, day, h, m, 0).getTime();
      const oneHourBefore = dueWithTime - 60 * 60 * 1000;
      if (oneHourBefore > now) {
        const timeLabel = new Date(dueWithTime).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit',
        });
        schedule.push({
          id: `${task.id}_1h`,
          title: '⏰ Kurhona Reminder',
          body: `${task.title} is due at ${timeLabel} — in 1 hour`,
          fireAt: oneHourBefore,
        });
      }
    }

    // Due date itself at midnight (no time set)
    if (!task.due_time) {
      const dueDateMs = new Date(year, month - 1, day).getTime();
      if (dueDateMs > now) {
        schedule.push({
          id: `${task.id}_now`,
          title: '⏰ Kurhona Reminder',
          body: `${task.title} is due today`,
          fireAt: dueDateMs,
        });
      }
    }
  }

  return schedule;
}

async function sendScheduleToSW(schedule: ScheduledNotification[]): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg?.active) return;
    reg.active.postMessage({ type: 'SCHEDULE_NOTIFICATIONS', notifications: schedule });
  } catch { /* SW not yet active */ }
}

async function cancelAllInSW(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg?.active) return;
    reg.active.postMessage({ type: 'CANCEL_ALL' });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Web Push subscription helpers
// ---------------------------------------------------------------------------

async function getOrCreateSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;

  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
}

async function saveSubscriptionToSupabase(sub: PushSubscription, userId: string): Promise<void> {
  const json = sub.toJSON();
  const keys = json.keys as { p256dh: string; auth: string };

  await supabase.from('push_subscriptions').upsert(
    {
      user_id:  userId,
      endpoint: sub.endpoint,
      p256dh:   keys.p256dh,
      auth_key: keys.auth,
    },
    { onConflict: 'endpoint' }
  );
}

async function removeSubscriptionFromSupabase(endpoint: string): Promise<void> {
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNotifications(tasks: Task[], userId?: string): UseNotificationsReturn {
  const isSupported    = checkSupport();
  const isIosWithoutPwa = isIos() && !isInStandalone();

  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    isSupported ? Notification.permission : 'unsupported'
  );
  const [isEnabled, setIsEnabled] = useState<boolean>(() => {
    if (!isSupported) return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  const tasksRef  = useRef(tasks);
  const userIdRef = useRef(userId);
  useEffect(() => { tasksRef.current = tasks; },   [tasks]);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  // Register service worker on mount
  useEffect(() => {
    if (!isSupported) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, [isSupported]);

  // Re-sync client-side schedule whenever tasks/enabled/permission changes
  useEffect(() => {
    if (!isSupported) return;
    if (!isEnabled || permission !== 'granted') { cancelAllInSW(); return; }
    sendScheduleToSW(buildSchedule(tasks));
  }, [tasks, isEnabled, permission, isSupported]);

  // Poll permission in case user changes it externally in browser settings
  useEffect(() => {
    if (!isSupported) return;
    const id = setInterval(() => {
      const cur = Notification.permission;
      setPermission((prev) => (prev !== cur ? cur : prev));
    }, 5000);
    return () => clearInterval(id);
  }, [isSupported]);

  const toggle = useCallback(async () => {
    if (!isSupported) return;

    // iOS outside PWA — guide user to install
    if (isIosWithoutPwa) {
      alert(
        '📲 To enable deadline notifications on iPhone/iPad:\n\n' +
        '1. Tap the Share button (□↑) in Safari\n' +
        '2. Choose "Add to Home Screen"\n' +
        '3. Open Kurhona from your Home Screen\n' +
        '4. Then tap the bell button to enable alerts'
      );
      return;
    }

    if (isEnabled) {
      // Turn off — unsubscribe from push and remove from DB
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
          await removeSubscriptionFromSupabase(sub.endpoint);
          await sub.unsubscribe();
        }
      } catch { /* ignore */ }
      await cancelAllInSW();
      setIsEnabled(false);
      localStorage.setItem(STORAGE_KEY, 'false');
      return;
    }

    // Request browser permission
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') return;
    } else if (Notification.permission === 'denied') {
      if (isIos()) {
        alert(
          '🔕 Notifications are blocked.\n\n' +
          'To re-enable on iPhone / iPad:\n\n' +
          'Option 1 — Fastest:\n' +
          '  Tap the AA (or 🔒) icon in the Safari address bar\n' +
          '  → Website Settings → Notifications → Allow\n\n' +
          'Option 2 — Settings app:\n' +
          '  Settings → Safari → Notifications\n' +
          '  → find Kurhona → tap Allow'
        );
      } else {
        alert(
          '🔕 Notifications are blocked.\n\n' +
          'To re-enable:\n' +
          '• Tap the 🔒 lock icon in the address bar\n' +
          '  → Notifications → Allow\n' +
          '• Or: Settings → Site Settings → Notifications'
        );
      }
      return;
    }

    // Subscribe to Web Push (VAPID) and save to Supabase
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await getOrCreateSubscription(reg);
      const uid = userIdRef.current;
      if (uid) await saveSubscriptionToSupabase(sub, uid);
    } catch (err) {
      console.warn('Push subscription failed:', err);
      // Fall back to client-side schedule only
    }

    // Enable client-side fallback schedule
    setIsEnabled(true);
    localStorage.setItem(STORAGE_KEY, 'true');
    sendScheduleToSW(buildSchedule(tasksRef.current));
  }, [isEnabled, isSupported, isIosWithoutPwa]);

  return { isSupported, isIosWithoutPwa, permission, isEnabled, toggle };
}
