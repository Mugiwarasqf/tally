import { addDays, diffDays } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import type { Account, ImportedFile } from '../types';

export interface Span {
  start: ISODate;
  end: ISODate;
}

export interface AccountCoverage {
  account: Account;
  spans: Span[]; // merged, sorted
  gaps: Span[]; // days between spans that no statement covers
  first?: ISODate;
  last?: ISODate;
}

/** Which dates each account's statements cover, and where the holes are. */
export function coverage(accounts: Account[], files: ImportedFile[]): AccountCoverage[] {
  return accounts.map((account) => {
    const spans = files
      .filter((f) => f.accountId === account.id && f.periodStart && f.periodEnd)
      .map((f) => ({ start: f.periodStart!, end: f.periodEnd! }))
      .sort((a, b) => a.start.localeCompare(b.start));
    const merged: Span[] = [];
    for (const s of spans) {
      const last = merged.at(-1);
      if (last && s.start <= addDays(last.end, 1)) last.end = s.end > last.end ? s.end : last.end;
      else merged.push({ ...s });
    }
    const gaps = merged.slice(1).map((s, i) => ({ start: addDays(merged[i]!.end, 1), end: addDays(s.start, -1) }));
    return { account, spans: merged, gaps, first: merged[0]?.start, last: merged.at(-1)?.end };
  });
}

/** Latest date any statement covers — the point "live" figures can be trusted up to. */
export const lastCovered = (cov: AccountCoverage[]): ISODate | undefined =>
  cov.map((c) => c.last).filter((d): d is ISODate => !!d).sort().at(-1);

export const staleDays = (cov: AccountCoverage[], today: ISODate): number | null => {
  const last = lastCovered(cov);
  return last ? Math.max(0, diffDays(last, today)) : null;
};
