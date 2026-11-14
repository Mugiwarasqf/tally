import { useMemo, useState } from 'react';
import { useApp } from '../../app/data';
import { addRule, deleteRule, recategorizeAll } from '../../data/actions';
import { saveSettings } from '../../data/settings';
import type { Profile } from '../../domain/types';
import { fmtDay } from '../../lib/dates';
import { fmt } from '../../lib/money';
import { Icon } from '../icons';
import { MoneyInput, Segmented, Switch } from './bits';
import { useToast } from './overlay';

type Cadence = NonNullable<Profile['payCadence']>;
const CARD = new Set(['VIS', ')))', 'ATM']);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

interface Group { mkey: string; merchant: string; n: number; typical: number; last: string; categoryId: string }

/** Credits or debits grouped by payee, biggest count first. */
function groupBy(txns: Array<{ mkey: string; merchant: string; amount: number; date: string; categoryId: string; type: string; catSource: string }>): Group[] {
  const m = new Map<string, typeof txns>();
  for (const t of txns) m.set(t.mkey, [...(m.get(t.mkey) ?? []), t]);
  return [...m.entries()]
    .map(([mkey, ts]) => ({ mkey, merchant: ts[ts.length - 1]!.merchant, n: ts.length, typical: median(ts.map((t) => Math.abs(t.amount))), last: ts.map((t) => t.date).sort().at(-1)!, categoryId: ts[0]!.categoryId }))
    .sort((a, b) => b.n - a.n);
}

/**
 * The profile step: what you earn, how often, and what you pay in rent, in your own words. Tally then asks which
 * statement lines those are, instead of guessing. Each answer becomes a rule, so future imports follow it too.
 */
export function ProfileForm({ onDone }: { onDone?: () => void }) {
  const { txns, settings, rules } = useApp();
  const toast = useToast();
  const p = settings.profile ?? {};
  const [pay, setPay] = useState(p.payAmount ?? 0);
  const [cadence, setCadence] = useState<Cadence>(p.payCadence ?? 'weekly');
  const [payKeys, setPayKeys] = useState<Set<string>>(new Set(p.payKeys ?? []));
  const [rent, setRent] = useState(p.rentAmount ?? 0);
  const [billsIn, setBillsIn] = useState(p.rentIncludesBills ?? false);
  const [rentKey, setRentKey] = useState(p.rentKey ?? '');
  const [busy, setBusy] = useState(false);

  // Candidate payers: credits near the declared amount, anything already labelled salary, and anything already ticked.
  const payCandidates = useMemo(() => {
    const credits = groupBy(txns.filter((t) => t.amount > 0 && t.catSource !== 'own' && !t.mkey.startsWith('acct ')));
    return credits.filter((g) => payKeys.has(g.mkey) || g.categoryId === 'salary' || (pay > 0 && Math.abs(g.typical - pay) <= pay * 0.25)).slice(0, 8);
  }, [txns, pay, payKeys]);
  // Candidate landlords: bank-transfer payments near the declared rent, plus anything already labelled housing.
  const rentCandidates = useMemo(() => {
    const debits = groupBy(txns.filter((t) => t.amount < 0 && !CARD.has(t.type) && t.catSource !== 'own' && !t.mkey.startsWith('acct ')));
    return debits.filter((g) => g.mkey === rentKey || g.categoryId === 'housing' || (rent > 0 && Math.abs(g.typical - rent) <= Math.max(100, rent * 0.05))).slice(0, 6);
  }, [txns, rent, rentKey]);

  const save = async () => {
    setBusy(true);
    try {
      const profile: Profile = {
        payAmount: pay || undefined, payCadence: pay ? cadence : undefined, payKeys: [...payKeys],
        rentAmount: rent || undefined, rentIncludesBills: billsIn, rentKey: rentKey || undefined,
      };
      await saveSettings({ profile });
      // Rules: one per confirmed payer (salary, money in) and one for the landlord (housing, money out).
      for (const r of rules.filter((r) => r.profile)) await deleteRule(r.id);
      for (const k of payKeys) await addRule({ kind: 'user', match: 'merchant', pattern: k, categoryId: 'salary', dir: 'in', profile: 'pay' });
      if (rentKey) await addRule({ kind: 'user', match: 'merchant', pattern: rentKey, categoryId: 'housing', dir: 'out', profile: 'rent' });
      const n = await recategorizeAll();
      toast(n ? `Saved. ${n} transaction${n === 1 ? '' : 's'} updated.` : 'Saved');
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (k: string) => setPayKeys((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="profile">
      <div className="profile__grid">
        <div className="field">
          <label htmlFor="pay">Take-home pay, per payslip</label>
          <MoneyInput id="pay" value={pay} onChange={setPay} placeholder="e.g. 450" />
          <span className="field__hint">What actually lands in your account. If it varies a little, use a typical week.</span>
        </div>
        <div className="field">
          <span className="field__label">How often you’re paid</span>
          <Segmented<Cadence> label="Pay frequency" value={cadence} onChange={setCadence} options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Every 2 weeks' }, { value: 'monthly', label: 'Monthly' }]} />
        </div>
      </div>
      {payCandidates.length > 0 && (
        <div className="field">
          <span className="field__label">Which of these is your pay? Tick all that apply, including previous jobs.</span>
          <span className="field__hint">Changed jobs? Ticking past employers keeps your old months right. Only the amount above is planned on.</span>
          <div className="list">
            {payCandidates.map((g) => (
              <label key={g.mkey} className="pick">
                <input type="checkbox" checked={payKeys.has(g.mkey)} onChange={() => toggle(g.mkey)} />
                <span className="row__main">
                  <span className="row__title">{g.merchant}</span>
                  <span className="row__sub">{g.n} payment{g.n === 1 ? '' : 's'} · typically {fmt(g.typical)} · last {fmtDay(g.last)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="profile__grid">
        <div className="field">
          <label htmlFor="rent">Rent, per month</label>
          <MoneyInput id="rent" value={rent} onChange={setRent} placeholder="e.g. 500" />
          <span className="field__hint">Leave at 0 if you don’t pay rent.</span>
        </div>
        <label className="split">
          <span className="t-small">Bills are included in the rent</span>
          <Switch checked={billsIn} onChange={setBillsIn} label="Bills included in rent" />
        </label>
      </div>
      {rent > 0 && rentCandidates.length > 0 && (
        <div className="field">
          <span className="field__label">Who do you pay it to?</span>
          <div className="list">
            {rentCandidates.map((g) => (
              <label key={g.mkey} className="pick">
                <input type="radio" name="rentKey" checked={rentKey === g.mkey} onChange={() => setRentKey(g.mkey)} />
                <span className="row__main">
                  <span className="row__title">{g.merchant}</span>
                  <span className="row__sub">{g.n} payment{g.n === 1 ? '' : 's'} · {fmt(g.typical)} · last {fmtDay(g.last)}</span>
                </span>
              </label>
            ))}
            <label className="pick">
              <input type="radio" name="rentKey" checked={rentKey === ''} onChange={() => setRentKey('')} />
              <span className="row__main"><span className="row__title">None of these</span><span className="row__sub">Tally will still look for payments of {fmt(rent)}.</span></span>
            </label>
          </div>
        </div>
      )}

      <div className="cluster">
        <button className="btn btn--primary" onClick={save} disabled={busy}><Icon name="Check" size={18} weight="bold" />{busy ? 'Saving…' : 'Save'}</button>
        <span className="t-xs">Stays on this device, like everything else.</span>
      </div>
    </div>
  );
}
