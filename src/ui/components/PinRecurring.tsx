import { useMemo, useState } from 'react';
import { useApp } from '../../app/data';
import { saveSettings } from '../../data/settings';
import type { PinnedRecurring } from '../../domain/types';
import { fmtDay } from '../../lib/dates';
import { fmt } from '../../lib/money';
import { Icon } from '../icons';
import { CatTile, MoneyInput, Segmented } from './bits';
import { Sheet, useToast } from './overlay';

type Cadence = PinnedRecurring['cadence'];

/** Save or replace a pin, and un-hide it if the user had dismissed it earlier. */
export async function pinRecurring(pin: PinnedRecurring, current: { pinnedRecurring?: PinnedRecurring[]; dismissedRecurring: string[] }): Promise<void> {
  await saveSettings({
    pinnedRecurring: [...(current.pinnedRecurring ?? []).filter((p) => p.key !== pin.key), pin],
    dismissedRecurring: current.dismissedRecurring.filter((k) => k !== pin.key),
  });
}

export async function unpinRecurring(key: string, current: { pinnedRecurring?: PinnedRecurring[] }): Promise<void> {
  await saveSettings({ pinnedRecurring: (current.pinnedRecurring ?? []).filter((p) => p.key !== key) });
}

/**
 * Mark a payee as a recurring bill. Opened from a transaction (payee known) or from the Recurring page, where it
 * first lists every payee you've paid so you can pick one.
 */
export function PinRecurringSheet({ mkey, cadence: suggested, onClose }: { mkey?: string; cadence?: Cadence; onClose: () => void }) {
  const { txns, settings, catMap } = useApp();
  const toast = useToast();
  const [picked, setPicked] = useState<string | undefined>(mkey);
  const [q, setQ] = useState('');

  const payees = useMemo(() => {
    const m = new Map<string, { mkey: string; merchant: string; categoryId: string; amounts: number[]; last: string }>();
    for (const t of txns) {
      if (t.amount >= 0 || t.type === 'ATM' || catMap.get(t.categoryId)?.kind === 'transfer') continue;
      const g = m.get(t.mkey) ?? { mkey: t.mkey, merchant: t.merchant, categoryId: t.categoryId, amounts: [], last: t.date };
      g.amounts.push(-t.amount);
      if (t.date > g.last) { g.last = t.date; g.merchant = t.merchant; g.categoryId = t.categoryId; }
      m.set(t.mkey, g);
    }
    return [...m.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [txns, catMap]);

  const chosen = payees.find((p) => p.mkey === picked);
  const existing = settings.pinnedRecurring?.find((p) => p.key === `out:${picked}`);
  const lastAmount = chosen ? chosen.amounts[chosen.amounts.length - 1] ?? 0 : 0;
  const [cadence, setCadence] = useState<Cadence>(existing?.cadence ?? suggested ?? 'monthly');
  const [amount, setAmount] = useState<number>(existing?.amount ?? 0);
  const amt = amount || lastAmount;

  const save = async () => {
    if (!chosen || amt <= 0) return;
    await pinRecurring({ key: `out:${chosen.mkey}`, cadence, amount: amt }, settings);
    toast(`${chosen.merchant} added to recurring`);
    onClose();
  };

  if (!chosen) {
    const needle = q.trim().toLowerCase();
    const list = payees.filter((p) => !needle || p.merchant.toLowerCase().includes(needle)).slice(0, 60);
    return (
      <Sheet title="Add a recurring bill" onClose={onClose}>
        <p className="t-small">Pick who you pay. Most recent first.</p>
        <div className="search">
          <Icon name="MagnifyingGlass" size={18} />
          <input className="input" placeholder="Find a payee, e.g. Vodafone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a payee" />
        </div>
        <div className="list">
          {list.map((p) => (
            <button key={p.mkey} className="row row--hover" onClick={() => setPicked(p.mkey)}>
              <CatTile cat={catMap.get(p.categoryId)} size="sm" />
              <span className="row__main"><span className="row__title">{p.merchant}</span><span className="row__sub">{p.amounts.length} payment{p.amounts.length === 1 ? '' : 's'} · last {fmtDay(p.last)}</span></span>
              <span className="row__end row__amount">{fmt(p.amounts[p.amounts.length - 1]!)}</span>
            </button>
          ))}
          {!list.length && <p className="t-small">No payee matches “{q}”.</p>}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={`${chosen.merchant} as a recurring bill`} onClose={onClose}
      footer={<button className="btn btn--primary btn--block" onClick={save} disabled={amt <= 0}><Icon name="Check" size={18} weight="bold" />{existing ? 'Update' : 'Add to recurring'}</button>}
    >
      <p className="t-small">{chosen.amounts.length} payment{chosen.amounts.length === 1 ? '' : 's'} on your statements, the latest {fmt(lastAmount)} on {fmtDay(chosen.last)}. Tally will expect the next one on this rhythm and tell you if it’s missed.</p>
      <div className="field">
        <span className="field__label">How often</span>
        <Segmented<Cadence> label="How often" value={cadence} onChange={setCadence} options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Every 2 weeks' }, { value: 'monthly', label: 'Monthly' }]} />
      </div>
      <div className="field">
        <label htmlFor="pin-amount">Usual amount</label>
        <MoneyInput id="pin-amount" value={amt} onChange={setAmount} />
      </div>
    </Sheet>
  );
}
