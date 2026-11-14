import type { AlertItem, NotificationPrefs } from '../domain/types';
import { db } from './db';

const DAY = 86_400_000;

export type Support = 'unsupported' | 'default' | 'granted' | 'denied';

export const notificationSupport = (): Support =>
  typeof Notification === 'undefined' || !('serviceWorker' in navigator) ? 'unsupported' : (Notification.permission as Support);

/** Merge freshly computed alerts into the store without resurrecting ones already read or shown. */
export async function syncAlerts(items: AlertItem[]): Promise<void> {
  // The app re-computes alerts whenever data changes, so two syncs can overlap. Checking "is it new?" and
  // inserting must be one atomic step, or both runs see the same ID as new and the second insert fails.
  await db.transaction('rw', db.alerts, async () => {
    for (const a of items) if (!(await db.alerts.get(a.id))) await db.alerts.add(a);
  });
  // Housekeeping: drop anything older than 60 days.
  await db.alerts.where('at').below(Date.now() - 60 * DAY).delete();
}

export async function requestPermission(): Promise<Support> {
  if (notificationSupport() === 'unsupported') return 'unsupported';
  return (await Notification.requestPermission()) as Support;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** Show a system notification through the service worker (works even when the tab is in the background). */
export async function showSystem(a: Pick<AlertItem, 'id' | 'title' | 'body' | 'route'>): Promise<boolean> {
  const reg = await registration();
  if (!reg || notificationSupport() !== 'granted') return false;
  await reg.showNotification(a.title, { body: a.body, tag: a.id, icon: './icon-192.png', badge: './icon-192.png', data: { route: a.route } });
  return true;
}

/** Deliver every due, not-yet-shown alert as a system notification (at most five at a time). */
export async function deliverDue(prefs: NotificationPrefs): Promise<number> {
  if (!prefs.enabled || notificationSupport() !== 'granted') return 0;
  const due = await db.alerts.where('at').belowOrEqual(Date.now()).filter((a) => !a.shown && !a.read).toArray();
  let n = 0;
  for (const a of due.sort((x, y) => y.at - x.at).slice(0, 5)) {
    if (await showSystem(a)) {
      await db.alerts.update(a.id, { shown: true });
      n++;
    }
  }
  return n;
}

/**
 * Ask the browser to wake the service worker about twice a day, so reminders can fire while
 * the app is closed. Only installed Chromium PWAs honour this; elsewhere alerts appear when
 * the app is next opened.
 */
export async function enableBackgroundChecks(): Promise<boolean> {
  const reg = await registration();
  const ps = (reg as (ServiceWorkerRegistration & { periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void> } }) | null)?.periodicSync;
  if (!ps) return false;
  try {
    await ps.register('tally-alerts', { minInterval: 12 * 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

export async function setBadge(count: number): Promise<void> {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    /* badge API is optional */
  }
}
