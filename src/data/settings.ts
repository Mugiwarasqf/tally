import { db } from './db';
import type { Settings } from '../domain/types';

export const DEFAULT_SETTINGS: Settings = {
  monthStartDay: 1,
  theme: 'system',
  debtPlan: { strategy: 'avalanche', pace: 'balanced' },
  notifications: { enabled: false, budget: true, bills: true, debt: true, statements: true, weekly: true, missed: true, monthEnd: true, missedAfter: 2, debtMissedAfter: 1, items: {} },
  dismissedRecurring: [],
};

export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    debtPlan: { ...DEFAULT_SETTINGS.debtPlan, ...stored?.debtPlan },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...stored?.notifications },
  };
}

export async function loadSettings(): Promise<Settings> {
  const row = await db.kv.get('settings');
  return mergeSettings(row?.value as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings()), ...patch });
  await db.kv.put({ key: 'settings', value: next });
  applyTheme(next.theme);
  return next;
}

export function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem('tally.theme');
    else localStorage.setItem('tally.theme', theme);
  } catch {
    /* ignore */
  }
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0d0d' : '#f9f9f7');
}
