import type { RoutePath } from './router';

export interface NavItem {
  path: RoutePath;
  label: string;
  icon: string;
  /** What the page header says (falls back to label). */
  title?: string;
}

export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Overview',
    items: [
      { path: '/', label: 'Home', icon: 'House', title: 'Overview' },
      { path: '/cashflow', label: 'Cashflow', icon: 'ChartLineUp' },
      { path: '/transactions', label: 'Transactions', icon: 'ListBullets' },
    ],
  },
  {
    label: 'Plan',
    items: [
      { path: '/budget', label: 'Budget', icon: 'Target' },
      { path: '/debts', label: 'Debts', icon: 'Scales', title: 'Debt plan' },
      { path: '/recurring', label: 'Recurring', icon: 'ArrowsClockwise', title: 'Recurring payments' },
      { path: '/report', label: 'Report card', icon: 'GraduationCap', title: 'Month-end report card' },
    ],
  },
  {
    label: 'Understand',
    items: [
      { path: '/insights', label: 'Insights', icon: 'Lightbulb' },
      { path: '/import', label: 'Import', icon: 'UploadSimple', title: 'Import statements' },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = { path: '/settings', label: 'Settings', icon: 'Gear' };

export const ALL_NAV: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), SETTINGS_ITEM];
export const titleFor = (p: RoutePath): string => {
  const n = ALL_NAV.find((i) => i.path === p);
  return n?.title ?? n?.label ?? 'Tally';
};
