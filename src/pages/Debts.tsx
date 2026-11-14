import { useMemo, useState } from 'react';
import { useApp } from '../app/data';
import { deleteDebt, saveDebt } from '../data/actions';
import { saveSettings } from '../data/settings';
import type { PlanView } from '../domain/debt/plan';
import type { Debt, DebtKind, DebtPace, DebtStrategy } from '../domain/types';
import { addMonths, cycleLabel, fmtDay, today } from '../lib/dates';
import { fmt } from '../lib/money';
import { AlertRuleSheet, PayHistory, scheduleSummary } from '../ui/components/AlertRule';
import { Banner, CardHead, Empty, HeroMoney, IconTile, Meter, MoneyInput, Segmented, StatusChip } from '../ui/components/bits';
import { Sheet, useConfirm } from '../ui/components/overlay';
import { Icon } from '../ui/icons';
import { ChartCard, ChartTable } from '../ui/charts/core';
import { LineChart } from '../ui/charts/Lines';

const KINDS: Array<{ value: DebtKind; label: string; icon: string }> = [
  { value: 'card', label: 'Credit card', icon: 'CreditCard' },
  { value: 'loan', label: 'Loan', icon: 'Bank' },
  { value: 'overdraft', label: 'Overdraft', icon: 'Wallet' },
  { value: 'bnpl', label: 'Buy now, pay later', icon: 'Receipt' },
  { value: 'owed', label: 'Owed to a person', icon: 'UsersThree' },
  { value: 'other', label: 'Other', icon: 'Coins' },
];
const kindIcon = (k: DebtKind) => KINDS.find((x) => x.value === k)?.icon ?? 'Coins';
const monthName = (key: string) => cycleLabel(key, 1);

/** One line under a debt's name: rate, what's expected each month, and when it's due. */
function terms(d: PlanView['debts'][number]): string {
  const parts = [d.apr ? `${d.apr}% APR` : 'No interest'];
  if (d.needed > d.debt.minPayment && d.debt.deadline) parts.push(`${fmt(d.needed, { whole: true })}/mo to clear by ${fmtDay(d.debt.deadline)}`);
  else if (d.min > 0) parts.push(`min ${fmt(d.min, { whole: true })}`);
  else if (d.debt.deadline) parts.push(`pay by ${fmtDay(d.debt.deadline)}`);
  else parts.push('pay when you can');
  if (d.debt.dueDay) parts.push(`due ${ordinal(d.debt.dueDay)}`);
  return parts.join(' · ');
}

const STRATEGY_COPY: Record<DebtStrategy, string> = {
  avalanche: 'Highest interest rate first. Costs the least overall.',
  snowball: 'Smallest balance first. Quick wins that keep you going.',
};

export function Debts() {
  const { debts, plan, settings, planKey, schedules } = useApp();
  const [editing, setEditing] = useState<Debt | 'new' | null>(null);
  const [rule, setRule] = useState<{ key: string; title: string } | null>(null);
  const records = schedules.filter((s) => s.source === 'debt');

  if (!debts.length) {
    return (
      <>
        <section className="card">
          <Empty
            icon="Scales" title="Track what you owe"
            action={<button className="btn btn--primary" onClick={() => setEditing('new')}><Icon name="Plus" size={18} weight="bold" />Add a debt</button>}
          >
            Add credit cards, loans or buy-now-pay-later balances. Tally builds a repayment plan that fits your budget and shows the day you’ll be debt-free.
          </Empty>
        </section>
        {editing && <DebtSheet debt={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      </>
    );
  }

  const p = plan!;
  const original = p.debts.reduce((s, d) => s + d.original, 0);
  const repaid = original > 0 ? Math.max(0, 1 - p.totalBalance / original) : 0;

  return (
    <>
      <div className="bento">
        <section className="hero span-7" aria-label="Debt summary">
          {p.totalBalance > 0 ? (
            <>
              <span className="t-eyebrow">Total outstanding</span>
              <HeroMoney pence={p.totalBalance} />
              <div className="cluster">
                {p.debtFree
                  ? <span className="chip chip--on-hero"><Icon name="CalendarBlank" size={14} weight="fill" />Debt-free {monthName(p.debtFree)}</span>
                  : <span className="chip chip--on-hero"><Icon name="Warning" size={14} weight="fill" />Not paid off at this rate</span>}
                {p.plan.payoffMonths !== null && <span className="chip chip--on-hero">{p.plan.payoffMonths} month{p.plan.payoffMonths === 1 ? '' : 's'}</span>}
              </div>
              <Meter pct={repaid} onHero label="Share of original debt repaid" />
              <div className="stats stats--4 hero__stats">
                <div className="stat"><span className="stat__label">Per month</span><span className="stat__value">{fmt(p.monthly, { whole: true })}</span></div>
                <div className="stat"><span className="stat__label">Interest to come</span><span className="stat__value">{fmt(p.plan.totalInterest, { whole: true })}</span></div>
                <div className="stat"><span className="stat__label">Interest saved</span><span className="stat__value">{fmt(p.interestSaved, { whole: true })}</span></div>
                <div className="stat"><span className="stat__label">Months sooner</span><span className="stat__value">{p.monthsSaved ?? '—'}</span></div>
              </div>
            </>
          ) : (
            <>
              <span className="t-eyebrow">Debt-free</span>
              <h2 className="t-display">Every debt is cleared.</h2>
              <p className="t-small">Archive them, or add a new one if something changes.</p>
            </>
          )}
        </section>

        <PlanControls p={p} />

        <section className="card span-7">
          <CardHead title="What you owe" action={<button className="btn btn--secondary btn--sm" onClick={() => setEditing('new')}><Icon name="Plus" size={16} weight="bold" />Add</button>} />
          <div className="list">
            {p.debts.map((d) => {
              const cleared = p.plan.clearedAt[d.id];
              const share = d.original > 0 ? Math.max(0, 1 - d.balance / d.original) : 0;
              return (
                <button key={d.id} className="row debt-row" onClick={() => setEditing(d.debt)}>
                  <IconTile name={kindIcon(d.debt.kind)} tone="ink" />
                  <span className="row__main">
                    <span className="row__title">{d.name}</span>
                    <span className="row__sub">{terms(d)}</span>
                    <Meter pct={share} status="ontrack" label={`${d.name} repaid`} />
                  </span>
                  <span className="row__end">
                    <span className="row__amount">{fmt(d.balance, { whole: true })}</span>
                    <div className="t-xs">{d.balance <= 0 ? 'Cleared' : cleared ? `Clear ${monthName(addMonths(planKey, cleared - 1))}` : ''}</div>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {records.length > 0 && (
          <section className="card span-12">
            <CardHead title="Payment record" sub="Each due date against the payments Tally found. Only dates your statements cover are judged." />
            <div className="list">
              {records.map((s) => (
                <div key={s.key} className="record">
                  <div className="record__head">
                    <span className="row__title">{s.label}</span>
                    <span className="t-small">{scheduleSummary(s)}</span>
                  </div>
                  <PayHistory s={s} />
                  <button className="btn btn--secondary btn--sm" onClick={() => setRule({ key: s.key, title: s.label })}>
                    <Icon name={(settings.notifications.items[s.key]?.missed ?? 'default') === 'off' ? 'Bell' : 'BellRinging'} size={16} />Alerts
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <Affordable p={p} />

        <ChartCard
          className="span-12" title="Road to debt-free" sub="Total outstanding, month by month. The grey line is paying only the minimums."
          legend={<div className="legend"><span className="legend__item"><i className="legend__sw" style={{ background: 'var(--c1)' }} />Your plan</span><span className="legend__item"><i className="legend__sw" style={{ background: 'var(--c-other)' }} />Minimums only</span></div>}
          table={<ChartTable head={['Month', 'Your plan', 'Minimums only']} rows={projection(p).rows} />}
        >
          <LineChart
            label="Projected total debt, your plan compared with minimum payments"
            labels={projection(p).labels} titles={projection(p).titles}
            series={[{ name: 'Your plan', color: 'var(--c1)', values: projection(p).plan, area: true }, { name: 'Minimums only', color: 'var(--c-other)', values: projection(p).base }]}
            height={260}
          />
        </ChartCard>

        <section className="card span-7">
          <CardHead title="This month’s payments" sub={monthName(planKey)} />
          <div className="tablewrap">
            <table className="table">
              <thead><tr><th>Debt</th><th className="r">Minimum</th><th className="r">Plan pays</th><th className="r">Balance after</th></tr></thead>
              <tbody>
                {p.debts.filter((d) => d.balance > 0).map((d) => {
                  const m = p.plan.months[0];
                  const pay = m?.payments[d.id] ?? 0;
                  return (
                    <tr key={d.id}>
                      <td>{d.name}</td><td className="r">{fmt(d.min)}</td>
                      <td className="r"><strong>{fmt(pay)}</strong>{pay > d.min ? <span className="chip chip--brand" style={{ marginLeft: 8 }}>+{fmt(pay - d.min, { whole: true })}</span> : null}</td>
                      <td className="r">{fmt(m?.balances[d.id] ?? d.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><td><strong>Total</strong></td><td className="r">{fmt(p.afford.minTotal)}</td><td className="r"><strong>{fmt(p.plan.months[0]?.total ?? 0)}</strong></td><td className="r">{fmt(p.plan.months[0]?.balance ?? 0)}</td></tr></tfoot>
            </table>
          </div>
        </section>

        <section className="card span-5">
          <CardHead title="Payoff order" sub={settings.debtPlan.strategy === 'avalanche' ? 'Highest interest first' : 'Smallest balance first'} />
          <ol className="order">
            {[...p.debts].filter((d) => d.balance > 0).sort((a, b) => (p.plan.clearedAt[a.id] ?? 999) - (p.plan.clearedAt[b.id] ?? 999)).map((d, i) => (
              <li key={d.id}>
                <span className="order__n">{i + 1}</span>
                <span className="row__title">{d.name}</span>
                <span className="t-small">{p.plan.clearedAt[d.id] ? monthName(addMonths(planKey, p.plan.clearedAt[d.id]! - 1)) : 'Not cleared'}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {editing && <DebtSheet debt={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {rule && <AlertRuleSheet itemKey={rule.key} title={rule.title} source="debt" onClose={() => setRule(null)} />}
    </>
  );
}

const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n) ? 0 : n % 10] ?? 'th'}`;

function projection(p: PlanView) {
  const horizon = Math.min(120, Math.max(p.plan.months.length, p.baseline.payoffMonths ?? 60, 12));
  const labels: string[] = [];
  const titles: string[] = [];
  const plan: number[] = [];
  const base: number[] = [];
  const rows: string[][] = [];
  const now = p.totalBalance;
  for (let i = 0; i <= horizon; i++) {
    const key = addMonths(today().slice(0, 7), i);
    const a = i === 0 ? now : (p.plan.months[i - 1]?.balance ?? 0);
    const b = i === 0 ? now : (p.baseline.months[i - 1]?.balance ?? 0);
    labels.push(cycleLabel(key, 1, true));
    titles.push(monthName(key));
    plan.push(a);
    base.push(b);
    if (i % Math.max(1, Math.round(horizon / 18)) === 0) rows.push([monthName(key), fmt(a), fmt(b)]);
  }
  return { labels, titles, plan, base, rows };
}

function PlanControls({ p }: { p: PlanView }) {
  const { settings } = useApp();
  const dp = settings.debtPlan;
  const set = (patch: Partial<typeof dp>) => saveSettings({ debtPlan: { ...dp, ...patch } });
  const a = p.afford;
  const low = a.minTotal;
  const high = Math.max(a.ceiling, low);
  const custom = dp.customMonthly ?? p.monthly;
  const months = dp.targetMonths ?? 24;

  return (
    <section className="card span-5 controls">
      <CardHead title="Your plan" sub="Pick a pace that fits your budget" />
      <Segmented<DebtPace>
        label="Payment pace" wrap value={dp.pace} onChange={(v) => set({ pace: v })}
        options={[{ value: 'minimum', label: 'Minimums' }, { value: 'balanced', label: 'Balanced' }, { value: 'fast', label: 'Fast' }, { value: 'custom', label: 'Custom' }, { value: 'target', label: 'By a date' }]}
      />
      <div className="monthly">
        <span className="t-xs">Monthly payment</span>
        <span className="t-stat">{fmt(p.monthly)}</span>
        <span className="t-small">
          {dp.pace === 'minimum' && 'Just the minimums. The safest cash flow, the slowest and costliest route.'}
          {dp.pace === 'balanced' && 'Minimums plus half of what’s comfortably spare each month.'}
          {dp.pace === 'fast' && 'Minimums plus most of what’s spare. Quicker, but leaves less slack.'}
          {dp.pace === 'custom' && 'Your own amount.'}
          {dp.pace === 'target' && (p.targetPayment ? `Needed to be debt-free in ${months} months.` : 'No payment clears this within any sensible time.')}
        </span>
      </div>

      {dp.pace === 'custom' && (
        <div className="field">
          <label htmlFor="custom">Pay each month</label>
          <MoneyInput id="custom" value={custom} onChange={(v) => set({ customMonthly: Math.max(low, v) })} />
          <input type="range" min={low / 100} max={Math.max(high, custom) / 100} step={5} value={custom / 100} onChange={(e) => set({ customMonthly: Math.round(Number(e.target.value) * 100) })} aria-label="Monthly payment" />
          <div className="split t-xs"><span>Minimum {fmt(low, { whole: true })}</span><span>Comfortable max {fmt(high, { whole: true })}</span></div>
        </div>
      )}
      {dp.pace === 'target' && (
        <div className="field">
          <label htmlFor="months">Debt-free in (months)</label>
          <div className="stepper">
            <button className="icon-btn" onClick={() => set({ targetMonths: Math.max(1, months - 1) })} aria-label="Fewer months">−</button>
            <input id="months" className="input num" type="number" min={1} max={120} value={months} onChange={(e) => set({ targetMonths: Math.min(120, Math.max(1, Number(e.target.value) || 1)) })} />
            <button className="icon-btn" onClick={() => set({ targetMonths: Math.min(120, months + 1) })} aria-label="More months">+</button>
          </div>
        </div>
      )}
      {p.monthly > high && a.available > 0 && <Banner tone="warn" icon="Warning">That’s more than the {fmt(high, { whole: true })} Tally considers comfortable, so it eats into your buffer.</Banner>}

      <div className="field">
        <span className="field__label">Order</span>
        <Segmented<DebtStrategy> label="Payoff strategy" value={dp.strategy} onChange={(v) => set({ strategy: v })} options={[{ value: 'avalanche', label: 'Avalanche' }, { value: 'snowball', label: 'Snowball' }]} />
        <span className="field__hint">{STRATEGY_COPY[dp.strategy]}</span>
      </div>
    </section>
  );
}

function Affordable({ p }: { p: PlanView }) {
  const a = p.afford;
  const status = a.shortfall > 0 ? 'over' : a.available - a.buffer < a.minTotal * 1.3 ? 'watch' : 'ontrack';
  return (
    <section className="card span-5">
      <CardHead title="What’s reasonable" sub="Worked out from your budget for this month" action={<StatusChip status={status} label={status === 'over' ? 'Tight' : status === 'watch' ? 'Snug' : 'Comfortable'} />} />
      <dl className="sum">
        <div><dt>Expected income</dt><dd>{fmt(a.income, { whole: true })}</dd></div>
        <div><dt>Planned spending</dt><dd>−{fmt(a.plannedSpend, { whole: true })}</dd></div>
        <div><dt>Savings</dt><dd>−{fmt(a.savings, { whole: true })}</dd></div>
        <div><dt>Buffer kept back (10%)</dt><dd>−{fmt(a.buffer, { whole: true })}</dd></div>
        <div className="sum__total"><dt>Comfortable for debt</dt><dd>{fmt(Math.max(0, a.available - a.buffer), { whole: true })}</dd></div>
      </dl>
      <div className="rungs">
        {[['Minimums', a.minimum], ['Balanced', a.balanced], ['Fast', a.fast]].map(([n, v]) => (
          <div key={n as string} className="rung"><span className="t-xs">{n}</span><span className="t-h2 num">{fmt(v as number, { whole: true })}</span></div>
        ))}
      </div>
      {(a.shortfall > 0 || p.debtFree === null) && (
        <Banner tone="critical" icon="WarningCircle">
          <strong>{a.shortfall > 0 ? `Your minimums are ${fmt(a.shortfall, { whole: true })} more than your budget allows.` : 'These payments don’t outrun the interest.'}</strong>
          <div className="t-small">Trim flexible spending, or get free, independent help: <a className="link" href="https://www.stepchange.org" target="_blank" rel="noopener noreferrer">StepChange</a>, <a className="link" href="https://www.moneyhelper.org.uk" target="_blank" rel="noopener noreferrer">MoneyHelper</a> or <a className="link" href="https://www.citizensadvice.org.uk" target="_blank" rel="noopener noreferrer">Citizens Advice</a>.</div>
        </Banner>
      )}
    </section>
  );
}

function DebtSheet({ debt, onClose }: { debt: Debt | null; onClose: () => void }) {
  const ask = useConfirm();
  const { txns } = useApp();
  const [deadline, setDeadline] = useState(debt?.deadline ?? '');
  const [name, setName] = useState(debt?.name ?? '');
  const [kind, setKind] = useState<DebtKind>(debt?.kind ?? 'card');
  const [balance, setBalance] = useState(debt?.balance ?? 0);
  const [apr, setApr] = useState(String(debt?.apr ?? ''));
  const [min, setMin] = useState(debt?.minPayment ?? 0);
  const [dueDay, setDueDay] = useState(String(debt?.dueDay ?? ''));
  const [match, setMatch] = useState(debt?.match ?? '');
  const [asOf, setAsOf] = useState(debt?.asOf ?? today());
  const [err, setErr] = useState('');

  const valid = useMemo(() => name.trim() && balance > 0, [name, balance]);
  const person = kind === 'owed';

  // Statements print names as the bank stores them (often shortened), so offer the forms that actually appear.
  const seen = useMemo(() => {
    if (!person) return [];
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    if (!words.length) return [];
    const counts = new Map<string, number>();
    for (const t of txns) {
      if (t.amount >= 0) continue;
      const m = t.merchant.toLowerCase();
      if (words.some((w) => m.includes(w))) counts.set(t.merchant, (counts.get(t.merchant) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => ({ merchant: m, n }));
  }, [person, name, txns]);

  const save = async () => {
    const rate = Number(apr || 0);
    if (!name.trim()) return setErr('Give it a name.');
    if (balance <= 0) return setErr('Enter what you owe.');
    if (!(rate >= 0 && rate <= 100)) return setErr('APR should be between 0 and 100.');
    await saveDebt({ id: debt?.id, name: name.trim(), kind, balance, asOf, apr: rate, minPayment: min, dueDay: dueDay ? Number(dueDay) : undefined, match: match.trim() || undefined, deadline: deadline || undefined });
    onClose();
  };
  return (
    <Sheet
      title={debt ? 'Edit debt' : 'Add a debt'} onClose={onClose}
      footer={<>
        {debt && <button className="btn btn--danger" onClick={async () => { if (await ask({ title: `Delete ${debt.name}?`, body: 'It will be removed from your plan. Your transactions are not affected.', confirmLabel: 'Delete', danger: true })) { await deleteDebt(debt.id); onClose(); } }}>Delete</button>}
        <span className="grow" />
        <button className="btn btn--primary" onClick={save} disabled={!valid}>Save</button>
      </>}
    >
      <div className="form-grid form-grid--2">
        <div className="field"><label htmlFor="d-name">{person ? 'Who do you owe?' : 'Name'}</label><input id="d-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={person ? 'e.g. Jamie Rivera' : 'e.g. Barclaycard'} /></div>
        <div className="field"><label htmlFor="d-kind">Type</label><select id="d-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as DebtKind)}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></div>
        <div className="field"><label htmlFor="d-bal">Amount owed</label><MoneyInput id="d-bal" value={balance} onChange={setBalance} /></div>
        <div className="field"><label htmlFor="d-asof">As of</label><input id="d-asof" className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        <div className="field"><label htmlFor="d-apr">Interest (APR)</label><span className="input-wrap"><input id="d-apr" className="input" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /><span className="input-wrap__suffix">%</span></span><span className="field__hint">{person ? 'Usually 0 for friends and family.' : 'Use 0 for interest-free.'}</span></div>
        <div className="field"><label htmlFor="d-min">{person ? 'Agreed monthly payment' : 'Minimum payment'}</label><MoneyInput id="d-min" value={min} onChange={setMin} />{person && <span className="field__hint">Leave empty if there’s no set amount.</span>}</div>
        <div className="field"><label htmlFor="d-by">Pay off by <span className="muted">(optional)</span></label><input id="d-by" className="input" type="date" value={deadline} min={asOf} onChange={(e) => setDeadline(e.target.value)} /><span className="field__hint">Tally works out the monthly amount needed to clear it in time.</span></div>
        <div className="field"><label htmlFor="d-due">Due on day</label><select id="d-due" className="select" value={dueDay} onChange={(e) => setDueDay(e.target.value)}><option value="">No fixed day</option>{Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{ordinal(i + 1)}</option>)}</select></div>
        <div className="field">
          <label htmlFor="d-match">{person ? 'Their name on your statement' : 'Spot repayments by text'}</label>
          <input id="d-match" className="input" value={match} onChange={(e) => setMatch(e.target.value)} placeholder={person ? 'e.g. jamie rivera' : 'e.g. barclaycard'} />
          <span className="field__hint">Payments out containing this text count as repayments and reduce the balance automatically.</span>
          {seen.length > 0 && (
            <span className="cluster">
              {seen.map((s) => <button key={s.merchant} type="button" className="chip chip--btn" onClick={() => setMatch(s.merchant.toLowerCase())}>{s.merchant} · {s.n}</button>)}
            </span>
          )}
        </div>
      </div>
      {err && <Banner tone="critical">{err}</Banner>}
    </Sheet>
  );
}
