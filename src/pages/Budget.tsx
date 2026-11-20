import { useMemo, useState } from 'react';
import { useApp } from '../app/data';
import { saveCategory, setBudget } from '../data/actions';
import { db } from '../data/db';
import { history, suggestBudgets } from '../domain/analytics/budget';
import type { LineView } from '../domain/analytics/budget';
import { DEBT } from '../domain/categorize/categories';
import type { Category } from '../domain/types';
import { addMonths, cycleLabel, fmtDay } from '../lib/dates';
import { fmt } from '../lib/money';
import { bucketOf } from '../domain/categorize/categories';
import { saveSettings } from '../data/settings';
import { Banner, CardHead, CatTile, IconTile, Meter, MoneyInput, StatusChip } from '../ui/components/bits';
import { PeriodPill } from '../ui/components/Period';
import { BudgetSavings } from './BudgetSavings';
import { useConfirm, useToast } from '../ui/components/overlay';
import { Icon } from '../ui/icons';
import { everyday } from '../lib/region';

/** Plan a cycle (income, savings, debt, every category) and, for the current one, see how you're tracking. */
export function Budget() {
  const app = useApp();
  const { cycle, viewKey, txns, catMap, categories, budgets, settings, plan } = app;
  const toast = useToast();
  const ask = useConfirm();
  const startDay = settings.monthStartDay;
  const [adding, setAdding] = useState(false);
  const label = cycleLabel(viewKey, startDay);
  const tracking = cycle.phase !== 'future';

  const hist = useMemo(() => history(txns, catMap, viewKey, startDay), [txns, catMap, viewKey, startDay]);
  const rent = settings.profile?.rentAmount;
  const suggestion = useMemo(() => {
    const s = suggestBudgets(hist.spend, categories);
    if (rent && (s.get('housing') ?? 0) < rent) s.set('housing', rent); // declared rent beats what the statements happened to show
    return s;
  }, [hist, categories, rent]);
  const mine = budgets.filter((b) => b.month === viewKey);

  const visible = cycle.lines.filter((l) => l.category.id !== DEBT);
  const visibleIds = new Set(visible.map((l) => l.category.id));
  const addable = categories.filter((c) => c.kind === 'expense' && !visibleIds.has(c.id) && c.id !== 'unsorted-out');

  const fixed = visible.filter((l) => l.category.fixed);
  const flex = visible.filter((l) => !l.category.fixed);
  const debtLine = cycle.lines.find((l) => l.category.id === DEBT);

  const setPlan = (patch: { income?: number; savings?: number }) => db.plans.put({ month: viewKey, income: cycle.expectedIncome, savings: cycle.savingsGoal, ...patch });

  const fill = async () => {
    if (mine.length && !(await ask({ title: 'Replace your budgets?', body: `This overwrites the ${mine.length} budgets you've set for ${label} with suggestions based on your recent spending.`, confirmLabel: 'Replace' }))) return;
    for (const [id, amount] of suggestion) await setBudget(viewKey, id, amount);
    toast(`Matched your usual spending in ${suggestion.size} categories (no cuts)`);
  };
  const copyPrev = async () => {
    const prev = budgets.filter((b) => b.month === addMonths(viewKey, -1));
    if (!prev.length) { toast('Nothing to copy from the previous period'); return; }
    for (const b of prev) await setBudget(viewKey, b.categoryId, b.amount);
    toast(`Copied ${prev.length} budgets`);
  };

  const over = cycle.leftToAssign < 0;
  const assignedShare = cycle.expectedIncome > 0 ? Math.min(1, (cycle.budgetTotal + cycle.savingsGoal) / cycle.expectedIncome) : 0;

  return (
    <>
      <div className="page__head">
        <PeriodPill />
        <span className="spacer" />
        <button className="btn btn--secondary btn--sm" onClick={copyPrev}><Icon name="ArrowCounterClockwise" size={16} />Copy last period</button>
        <button className="btn btn--secondary btn--sm" onClick={fill} title="Set each budget to what you usually spend, with no cuts"><Icon name="Sparkle" size={16} />Match my usual spending</button>
      </div>

      <BudgetSavings />

      <div className="bento">
        {/* ------------------------------------------------------------ planner */}
        <div className="span-5 stack stack--lg">
        <section className="card planner">
          <CardHead title="Plan" sub={label} />
          <div className="field">
            <label htmlFor="income">Expected income</label>
            <MoneyInput id="income" value={app.plans.find((p) => p.month === viewKey)?.income ?? 0} placeholder={(cycle.expectedIncome / 100).toFixed(0)} onChange={(v) => setPlan({ income: v || undefined })} />
            <span className="field__hint">Leave blank to use the pay Tally detected. Type an amount to override it.</span>
          </div>
          <div className="field">
            <label htmlFor="savings">Set aside as savings</label>
            <MoneyInput id="savings" value={cycle.savingsGoal} onChange={(v) => setPlan({ savings: v })} />
          </div>
          <hr className="divider" />
          <dl className="sum">
            <div><dt>Income</dt><dd>{fmt(cycle.expectedIncome)}</dd></div>
            <div><dt>Savings</dt><dd>{less(cycle.savingsGoal)}</dd></div>
            <div><dt>Debt repayments</dt><dd>{less(cycle.debtPlanned)}</dd></div>
            <div><dt>Other budgets</dt><dd>{less(cycle.budgetTotal - cycle.debtPlanned)}</dd></div>
          </dl>
          <div className={`assign ${over ? 'assign--over' : ''}`}>
            <span className="t-eyebrow">{over ? 'Over-assigned by' : 'Left to assign'}</span>
            <span className="t-stat">{fmt(Math.abs(cycle.leftToAssign))}</span>
            <Meter pct={assignedShare} status={over ? 'over' : assignedShare > 0.92 ? 'watch' : 'under'} label="Share of income assigned" />
            <span className="t-xs">{over ? 'Trim a budget or lower savings until this reaches zero.' : cycle.leftToAssign === 0 ? 'Every pound has a job.' : 'Give it a job: a category, savings, or extra debt payment.'}</span>
          </div>
        </section>

        <IncomeCard />
        <Rule503020 />
        </div>

        {/* ----------------------------------------------------------- lines */}
        <div className="span-7 stack stack--lg">
          {mine.length === 0 && suggestion.size > 0 && (
            <Banner tone="brand" icon="Target" action={<button className="btn btn--primary btn--sm" onClick={fill}><Icon name="Sparkle" size={16} />Use my usual spending</button>}>
              <strong>No budgets set for {label} yet.</strong> The faded amounts below are suggestions from your usual spending. Fill them in as they are, or use “Build my savings budget” to apply the cuts first.
            </Banner>
          )}

          {debtLine && (
            <section className="card">
              <div className="row" style={{ cursor: 'default' }}>
                <CatTile cat={debtLine.category} />
                <span className="row__main">
                  <span className="row__title">Debt repayments</span>
                  <span className="row__sub">From your payment plan{plan?.debtFree ? ` · debt-free ${cycleLabel(plan.debtFree, startDay)}` : ''}</span>
                </span>
                <span className="row__end">
                  <span className="row__amount">{fmt(debtLine.budget)}</span>
                  {tracking && <div className="t-xs">{fmt(debtLine.spent)} paid</div>}
                </span>
              </div>
              <a className="link t-small" href="#/debts">Adjust the plan</a>
            </section>
          )}

          {[{ title: 'Fixed bills', sub: 'Assumed paid in full each cycle', rows: fixed }, { title: 'Flexible spending', sub: 'Paced day by day through the cycle', rows: flex }].map((g) => (
            <section className="card" key={g.title}>
              <CardHead title={g.title} sub={g.sub} />
              <div className="list">
                {g.rows.length === 0 && <p className="t-small">Nothing here yet.</p>}
                {g.rows.map((l) => <BudgetRow key={l.category.id} l={l} month={viewKey} tracking={tracking} suggestion={suggestion.get(l.category.id)} />)}
              </div>
            </section>
          ))}

          <section className="card card--quiet">
            {adding ? (
              <div className="menu" role="listbox" aria-label="Add a category to the budget">
                {addable.map((c) => (
                  <button key={c.id} className="menu__item" onClick={async () => { await setBudget(viewKey, c.id, suggestion.get(c.id) ?? everyday(50)); setAdding(false); }}>
                    <CatTile cat={c} size="sm" />{c.name}
                  </button>
                ))}
              </div>
            ) : (
              <button className="btn btn--ghost" onClick={() => setAdding(true)} disabled={!addable.length}><Icon name="Plus" size={18} weight="bold" />Add a category</button>
            )}
          </section>

          {cycle.phase === 'current' && cycle.projected > cycle.budgetTotal && cycle.budgetTotal > 0 && (
            <Banner tone="warn" icon="TrendUp"><strong>On pace to overshoot.</strong> You’re heading for about {fmt(cycle.projected, { whole: true })} against a {fmt(cycle.budgetTotal, { whole: true })} budget.</Banner>
          )}
        </div>
      </div>
    </>
  );
}

function BudgetRow({ l, month, tracking, suggestion }: { l: LineView; month: string; tracking: boolean; suggestion?: number }) {
  const cat: Category = l.category;
  const statusLabel = cat.fixed ? (l.status === 'ontrack' ? 'Paid' : l.status === 'over' ? 'Over' : 'Due') : undefined;
  return (
    <div className="brow">
      <CatTile cat={cat} />
      <div className="brow__main">
        <div className="brow__top">
          <span className="row__title">{cat.name}</span>
          <button className="chip chip--btn" onClick={() => saveCategory({ ...cat, fixed: !cat.fixed })} aria-label={`${cat.name} is ${cat.fixed ? 'fixed' : 'flexible'}. Switch.`} title="Switch between fixed bill and flexible spending">
            {cat.fixed ? 'Fixed' : 'Flexible'}
          </button>
        </div>
        {tracking && l.budget > 0 && (
          <>
            <Meter pct={l.pct} status={l.status} label={`${cat.name} budget used`} />
            <div className="split">
              <span className="t-xs num">{fmt(l.spent, { whole: true })} spent</span>
              {statusLabel ? <StatusChip status={l.status} label={statusLabel} /> : l.status === 'over' || l.status === 'watch' ? <StatusChip status={l.status} label={l.spent > l.budget ? 'Over budget' : undefined} /> : <span className="t-xs num">{fmt(Math.max(0, l.remaining), { whole: true })} left</span>}
            </div>
          </>
        )}
        {l.typical > 0 && <span className="t-xs">Usually {fmt(l.typical, { whole: true })} a month{suggestion && suggestion !== l.budget ? ` · suggest ${fmt(suggestion, { whole: true })}` : ''}</span>}
      </div>
      <div className="brow__input"><MoneyInput value={l.budget} onChange={(v) => setBudget(month, cat.id, v)} placeholder={!l.budget && suggestion ? (suggestion / 100).toFixed(0) : '0'} /></div>
    </div>
  );
}

/** An amount taken off, written "−£350.00", but plain "£0.00" when there is nothing to take off. */
const less = (n: number) => (n > 0 ? `−${fmt(n)}` : fmt(0));

const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n) ? 0 : n % 10] ?? 'th'}`;
const RHYTHM = { weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' } as const;

/** The stem: the pay streams Tally found, and what you can safely plan on this period. */
function IncomeCard() {
  const { income, cycle, settings, viewKey } = useApp();
  const startDay = settings.monthStartDay;
  const payday = income.payday;
  return (
    <section className="card">
      <CardHead title="Your income" sub={income.declared ? 'From your profile. Change it in Settings → About you.' : 'Found by rhythm: weekly, every two weeks or monthly'} />
      {income.streams.length === 0 ? (
        <p className="t-small">No regular pay found yet. Import a few months of statements and Tally will spot it.</p>
      ) : (
        <div className="list">
          {income.streams.map((s) => (
            <div className="row" key={s.key}>
              <IconTile name="Briefcase" tone="ink" size="sm" />
              <span className="row__main"><span className="row__title">{s.label}</span><span className="row__sub">{RHYTHM[s.cadence]} · about {fmt(s.monthly, { whole: true })} a month</span></span>
              <span className="row__end row__amount">{fmt(s.amount, { whole: true })}</span>
            </div>
          ))}
        </div>
      )}
      {income.past.length > 0 && (
        <div className="list">
          {income.past.map((p) => (
            <div className="row" key={p.mkey}>
              <IconTile name="Briefcase" tone="ink" size="sm" />
              <span className="row__main"><span className="row__title muted">{p.label}</span><span className="row__sub">Previous job · {RHYTHM[p.cadence].toLowerCase()} · {fmtDay(p.first)} – {fmtDay(p.last)}</span></span>
              <span className="row__end row__amount muted">{fmt(p.amount, { whole: true })}</span>
            </div>
          ))}
          <p className="t-xs">Pay from previous jobs stays as income in the months it arrived, but is never planned on.</p>
        </div>
      )}
      <dl className="sum">
        <div><dt>Regular pay</dt><dd>{fmt(income.regularMonthly, { whole: true })} / month</dd></div>
        {income.irregularMonthly > 0 && (
          <div><dt>{income.declared ? 'Other money in (not planned on)' : 'Other income (counts half)'}</dt><dd>{fmt(income.irregularMonthly, { whole: true })} / month</dd></div>
        )}
        <div className="sum__total"><dt>To plan on in {cycleLabel(viewKey, startDay)}</dt><dd>{fmt(cycle.expectedIncome, { whole: true })}</dd></div>
      </dl>
      {cycle.paydays > 2 && income.main && income.main.cadence !== 'monthly' && (
        <Banner tone="good" icon="Confetti"><strong>{cycle.paydays} paydays fall in this period.</strong> That’s one more than usual, so this is a good month to clear a debt or add to savings.</Banner>
      )}
      {payday !== undefined && payday <= 28 && payday !== startDay && (
        <button className="btn btn--secondary btn--sm" onClick={() => saveSettings({ monthStartDay: payday })}><Icon name="CalendarBlank" size={16} />Start my budget month on the {ordinal(payday)}</button>
      )}
    </section>
  );
}

/** Needs, wants, and saving or paying down debt, against the classic 50/30/20 guide. */
function Rule503020() {
  const { cycle } = useApp();
  const income = cycle.expectedIncome;
  if (income <= 0) return null;
  let needs = 0;
  let wants = 0;
  for (const l of cycle.lines) {
    if (l.category.kind !== 'expense') continue;
    const v = l.budget > 0 ? l.budget : 0;
    if (bucketOf(l.category) === 'needs') needs += v; else wants += v;
  }
  const future = cycle.savingsGoal + cycle.debtPlanned;
  const rows = [
    { label: 'Needs', hint: 'Housing, bills, food, transport', value: needs, target: 0.5, color: 'var(--c1)' },
    { label: 'Wants', hint: 'Eating out, shopping, fun', value: wants, target: 0.3, color: 'var(--c2)' },
    { label: 'Savings and debt', hint: 'Your future self', value: future, target: 0.2, color: 'var(--c3)' },
  ];
  return (
    <section className="card">
      <CardHead title="50 / 30 / 20 check" sub="A rule of thumb for how a budget balances" />
      <div className="stack">
        {rows.map((r) => {
          const share = r.value / income;
          const off = r.label === 'Savings and debt' ? share < r.target : share > r.target;
          return (
            <div key={r.label} className="stack stack--sm">
              <div className="split"><span className="row__title">{r.label}</span><span className="t-small num">{Math.round(share * 100)}% <span className="muted">of {Math.round(r.target * 100)}% guide</span></span></div>
              <div className="rbar__track" aria-hidden="true"><i style={{ width: `${Math.min(100, share * 100)}%`, background: r.color }} /><b style={{ left: `${r.target * 100}%` }} /></div>
              <span className="t-xs">{fmt(r.value, { whole: true })} · {r.hint}{off ? (r.label === 'Savings and debt' ? ' · below the guide' : ' · above the guide') : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
