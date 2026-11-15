import { diffDays } from '../../lib/dates';
import { TRANSFER } from '../categorize/categories';
import { REVIEW_THRESHOLD } from '../categorize/engine';
import type { Txn } from '../types';
import { everyday } from '../../lib/region';

export interface TxnPatch {
  id: string;
  patch: Partial<Txn>;
}

const LOCKED = new Set(['manual', 'rule', 'learned']);
const MAX_GAP_DAYS = 3;
const MIN_PENCE = () => everyday(1);
const REVERSAL_RE = /\b(?:REVERSAL|REVERSED|RVSL)\b/i;

/**
 * A transfer that fails comes back as a reversal a little later. Give the money that came back the same category as
 * the payment it reverses, so the two cancel out instead of counting as spending plus a refund.
 */
export function pairReversals(txns: Txn[]): TxnPatch[] {
  const backs = txns.filter((t) => t.amount > 0 && !LOCKED.has(t.catSource) && REVERSAL_RE.test(t.raw));
  const used = new Set<string>();
  const patches: TxnPatch[] = [];
  for (const b of backs) {
    let best: Txn | undefined;
    let bestGap = Infinity;
    for (const o of txns) {
      if (o.amount !== -b.amount || o.accountId !== b.accountId || used.has(o.id)) continue;
      const gap = diffDays(o.date, b.date);
      if (gap >= 0 && gap <= 5 && gap < bestGap) { best = o; bestGap = gap; }
    }
    if (!best) continue;
    used.add(best.id);
    patches.push({ id: b.id, patch: { categoryId: best.categoryId, catSource: 'pair', confidence: 0.9, reason: `Money back from a payment that was reversed (${best.date})` } });
    if (!LOCKED.has(best.catSource)) patches.push({ id: best.id, patch: { confidence: Math.max(best.confidence, 0.9), reason: 'Reversed: the money came back' } });
  }
  return patches;
}

/**
 * Money moved between two of your own accounts shows up twice: out of one, into
 * the other. Find opposite, equal amounts on different accounts within a few
 * days and mark both as a transfer, so neither inflates income or spending.
 * Only transactions the app is unsure about (or already thinks are transfers)
 * are considered, and anything the user set by hand is never touched.
 */
export function pairTransfers(txns: Txn[]): TxnPatch[] {
  const candidates = txns.filter(
    (t) => !LOCKED.has(t.catSource) && Math.abs(t.amount) >= MIN_PENCE() && (t.categoryId === TRANSFER || t.confidence < REVIEW_THRESHOLD || t.type === 'TFR'),
  );
  const outs = candidates.filter((t) => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
  const ins = candidates.filter((t) => t.amount > 0);
  const used = new Set<string>();
  const patches: TxnPatch[] = [];
  for (const o of outs) {
    let best: Txn | undefined;
    let bestGap = Infinity;
    for (const i of ins) {
      if (used.has(i.id) || i.accountId === o.accountId || i.amount !== -o.amount) continue;
      const gap = Math.abs(diffDays(o.date, i.date));
      if (gap <= MAX_GAP_DAYS && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (!best) continue;
    used.add(best.id);
    const patch: Partial<Txn> = { categoryId: TRANSFER, catSource: 'pair', confidence: 0.9, reason: 'Matching amount moved between two of your accounts' };
    patches.push({ id: o.id, patch }, { id: best.id, patch });
  }
  return patches;
}
