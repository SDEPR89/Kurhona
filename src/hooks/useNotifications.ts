import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledNotification {
  id: string;
  title: string;
  body: string;
  fireAt: number; // ms since epoch
}

export interface UseNotificationsReturn {
  /** Whether the browser supports notifications at all */
  isSupported: boolean;
  /** True on iOS Safari outside a PWA — push won't work until added to Home Screen */
  isIosWithoutPwa: boolean;
  /** Current permission state: 'default' | 'granted' | 'denied' */
  permission: NotificationPermission | 'unsupported';
  /** Whether notifications are currently enabled (granted + user opted in) */
  isEnabled: boolean;
  /** Toggle notifications on/off. Requests permission on first enable. */
  toggle: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'kurhona_notifications_enabled';

/** True on iPhone / iPad regardless of browser */
function isIos(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /iphone|ipad|ipod/i.test(navigator.userAgent)
  );
}

/** True when the web app is running as an installed PWA (standalone mode) */
function isInStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.navigator as any).standalone === true)
  );
}

/** Returns true if the browser supports the Notification API + service workers */
function checkSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator
  );
}

/**
 * Build the list of future notification fire-times for the given tasks.
 * Skips: completed tasks, submitted tasks, tasks without a due_date.
 * Fires: 3 days before (9 AM), 1 day before (9 AM), 1 hour before due_time.
 */
function buildSchedule(tasks: Task[]): ScheduledNotification[] {
  const now = Date.now();
  const schedule: ScheduledNotification[] = [];

  for (const task of tasks) {
    // Skip completed or submitted tasks
    if (task.completed_at) continue;
    if (task.status === 'submitted') continue;
    if (!task.due_date) continue;

    // Parse the due date at midnight local time
    const [year, month, day] = task.due_date.split('-').map(Number);
    const dueDateMs = new Date(year, month - 1, day).getTime();

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

    // 1 hour before due_time (only if due_time is set)
    if (task.due_time) {
      const [h, m] = task.due_time.split(':').map(Number);
      const dueWithTime = new Date(year, month - 1, day, h, m, 0).getTime();
      const oneHourBefore = dueWithTime - 60 * 60 * 1000;
      if (oneHourBefore > now) {
        const timeLabel = new Date(dueWithTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        schedule.push({
          id: `${task.id}_1h`,
          title: '⏰ Kurhona Reminder',
          body: `${task.title} is due at ${timeLabel} — in 1 hour`,
          fireAt: oneHourBefore,
        });
      }
    }

    // Overdue nudge — fire at exact due_date midnight if still in the future
    // (catches same-day tasks with no time set)
    if (dueDateMs > now && !task.due_time) {
      schedule.push({
        id: `${task.id}_now`,
        title: '⏰ Kurhona Reminder',
        body: `${task.title} is due today`,
        fireAt: dueDateMs,
      });
    }
  }

  return schedule;
}

/** Send the schedule to the registered service worker */
async function sendScheduleToSW(schedule: ScheduledNotification[]): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg?.active) return;
    reg.active.postMessage({ type: 'SCHEDULE_NOTIFICATIONS', notifications: schedule });
  } catch {
    // SW not yet active — will be scheduled on next page load
  }
}

/** Cancel all scheduled notifications in the service worker */
async function cancelAllInSW(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg?.active) return;
    reg.active.postMessage({ type: 'CANCEL_ALL' });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNotifications(tasks: Task[]): UseNotificationsReturn {
  const isSupported = checkSupport();
  // iOS Safari only supports push when running as an installed PWA
  const isIosWithoutPwa = isIos() && !isInStandalone();

  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    isSupported ? Notification.permission : 'unsupported'
  );

  const [isEnabled, setIsEnabled] = useState<boolean>(() => {
    if (!isSupported) return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  // Keep a stable ref to tasks so effects see the latest value
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  // Register service worker once on mount
  useEffect(() => {
    if (!isSupported) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // SW registration failed — notifications won't work but don't crash the app
    });
  }, [isSupported]);

  // Re-send schedule to SW whenever tasks or enabled state changes
  useEffect(() => {
    if (!isSupported) return;
    if (!isEnabled || permission !== 'granted') {
      cancelAllInSW();
      return;
    }
    const schedule = buildSchedule(tasks);
    sendScheduleToSW(schedule);
  }, [tasks, isEnabled, permission, isSupported]);

  // Sync permission state if the user changes it externally in browser settings
  useEffect(() => {
    if (!isSupported) return;
    const interval = setInterval(() => {
      const current = Notification.permission;
      setPermission((prev) => (prev !== current ? current : prev));
    }, 5000);
    return () => clearInterval(interval);
  }, [isSupported]);

  const toggle = useCallback(async () => {
    if (!isSupported) return;

    // iOS Safari outside PWA — push requires Home Screen install
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
      // Turn off
      setIsEnabled(false);
      localStorage.setItem(STORAGE_KEY, 'false');
      await cancelAllInSW();
      return;
    }

    // Turn on — request permission first if not yet granted
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') return; // user denied — don't enable
    } else if (Notification.permission === 'denied') {
      alert(
        '🔕 Notifications are blocked in your browser settings.\n\n' +
        'To re-enable:\n' +
        '• Chrome/Android: Settings → Site Settings → Notifications\n' +
        '• Safari: Settings → Safari → Notifications'
      );
      return;
    }

    setIsEnabled(true);
    localStorage.setItem(STORAGE_KEY, 'true');
    const schedule = buildSchedule(tasksRef.current);
    await sendScheduleToSW(schedule);
  }, [isEnabled, isSupported, isIosWithoutPwa]);

  return { isSupported, isIosWithoutPwa, permission, isEnabled, toggle };
}

