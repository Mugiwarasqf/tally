import { useMemo, useState } from 'react';
import { useApp } from '../app/data';
import { setBudget } from '../data/actions';
import { db } from '../data/db';
import { goalPresets } from '../domain/analytics/cuts';
import type { CutIdea, Effort } from '../domain/analytics/cuts';
import { cycleLabel } from '../lib/dates';
import { fmt } from '../lib/money';
import { Banner, CardHead, CatTile, IconTile, Meter, MoneyInput } from '../ui/components/bits';
import { useConfirm, useToast } from '../ui/components/overlay';
import { Icon } from '../ui/icons';

const EFFORT: Record<Effort, { label: string; icon: string; chip: string }> = {
  easy: { label: 'Easy', icon: 'CheckCircle', chip: 'chip--good' },
  medium: { label: 'Medium', icon: 'Gauge', chip: 'chip--warn' },
  hard: { label: 'Hard', icon: 'Fire', chip: 'chip--serious' },
};

/**
 * Savings-first budgeting. Pick what you want to save; Tally works out how much spending has to come down,
 * ranks the cuts that hurt least, and turns the ones you keep into your budget.
 */
export function BudgetSavings() {
  const { viewKey, settings, savingsFor, cycle, categories, catMap, budgets } = useApp();
  const toast = useToast();
  const ask = useConfirm();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const label = cycleLabel(viewKey, settings.monthStartDay);
  const goal = cycle.savingsGoal;

  const auto = useMemo(() => savingsFor(viewKey, { goal }), [savingsFor, viewKey, goal]);
  const plan = useMemo(() => (picked ? savingsFor(viewKey, { goal, selected: picked }) : auto), [picked, savingsFor, viewKey, goal, auto]);
  const presets = useMemo(() => goalPresets(plan.income), [plan.income]);

  // Change only the savings goal: keep any income override already set for this month.
  const setGoal = async (pence: number) => {
    setPicked(null);
    await db.plans.put({ ...(await db.plans.get(viewKey)), month: viewKey, savings: pence });
  };
  const toggle = (id: string) => {
    const next = new Set(plan.selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const build = async () => {
    const existing = budgets.filter((b) => b.month === viewKey).length;
    if (existing && !(await ask({ title: 'Replace your budgets?', body: `This sets ${label}'s budgets from the cuts you've kept, replacing the ${existing} you have now.`, confirmLabel: 'Build savings budget' }))) return;
    for (const c of categories) {
      if (c.kind !== 'expense') continue;
      await setBudget(viewKey, c.id, plan.targets.get(c.id) ?? 0);
    }
    toast(plan.identified > 0 ? `Savings budget set. Saves about ${fmt(plan.identified, { whole: true })} a month.` : 'Budget set from your usual spending');
  };

  const noIncome = plan.income <= 0;
  const counted = plan.ideas.filter((i) => i.counted);
  const insights = plan.ideas.filter((i) => !i.counted);

  return (
    <section className="card savings">
      <CardHead
        title="Save more by cutting costs"
        sub={`Start from what you want to save in ${label}. Tally works out what has to come down.`}
        action={<button className="btn btn--primary" onClick={build}><Icon name="PiggyBank" size={18} weight="fill" />Build my savings budget</button>}
      />

      <div className="goalrow">
        <div className="field">
          <span className="field__label">I want to save each month</span>
          <div className="cluster">
            {presets.map((g) => (
              <button key={g.label} className={`chip chip--btn goalchip${goal === g.amount ? ' is-on' : ''}`} aria-pressed={goal === g.amount} onClick={() => setGoal(g.amount)}>
                {g.label} · {fmt(g.amount, { whole: true })}
              </button>
            ))}
          </div>
        </div>
        <div className="field goalrow__input">
          <label htmlFor="goal">Or choose an amount</label>
          <MoneyInput id="goal" value={goal} onChange={setGoal} />
        </div>
      </div>

      {noIncome ? (
        <Banner tone="brand" icon="Briefcase">Add income, or import a few months of statements so Tally can find your pay, and it will work out exactly how much to cut.</Banner>
      ) : (
        <dl className="verdict">
          <div><dt>Your income</dt><dd>{fmt(plan.income, { whole: true })}</dd></div>
          <div><dt>Savings goal</dt><dd>−{fmt(plan.goal, { whole: true })}</dd></div>
          {plan.debt > 0 && <div><dt>Debt payments</dt><dd>−{fmt(plan.debt, { whole: true })}</dd></div>}
          <div className="verdict__key"><dt>You can spend</dt><dd>{fmt(Math.max(0, plan.spendable), { whole: true })}</dd></div>
          <div><dt>You usually spend</dt><dd>{fmt(plan.typicalSpend, { whole: true })}</dd></div>
          <div className={`verdict__key ${plan.need > 0 ? 'is-need' : 'is-ok'}`}><dt>{plan.need > 0 ? 'To cut' : 'Already on track'}</dt><dd>{plan.need > 0 ? fmt(plan.need, { whole: true }) : fmt(0, { whole: true })}</dd></div>
        </dl>
      )}

      {plan.need > 0 && (
        <div className="stack stack--sm">
          <div className="split">
            <span className="t-label">Cuts selected: {fmt(plan.identified, { whole: true })} of {fmt(plan.need, { whole: true })} needed</span>
            {plan.reachable
              ? <span className="chip chip--good"><Icon name="CheckCircle" size={14} weight="fill" />Goal reachable</span>
              : <span className="chip chip--warn"><Icon name="Warning" size={14} weight="fill" />{fmt(plan.gapLeft, { whole: true })} short</span>}
          </div>
          <Meter pct={plan.need ? plan.identified / plan.need : 1} status={plan.reachable ? 'ontrack' : 'watch'} label="Share of the needed cuts selected" />
          {!plan.reachable && (
            <p className="t-xs">
              {plan.potential >= plan.need
                ? 'Switch on more of the cuts below to close the gap.'
                : `Even every cut below only finds ${fmt(plan.potential, { whole: true })}. A smaller goal, or more income, would get you there.`}
            </p>
          )}
        </div>
      )}

      {counted.length > 0 ? (
        <ul className="cuts" aria-label="Ways to cut costs">
          {counted.map((i) => <CutRow key={i.id} idea={i} on={plan.selected.has(i.id)} onToggle={() => toggle(i.id)} cat={i.categoryId ? catMap.get(i.categoryId) : undefined} />)}
        </ul>
      ) : <p className="t-small">Nothing obvious to cut yet. Import a few months of statements so Tally can see where the money goes.</p>}

      {insights.map((i) => (
        <Banner key={i.id} tone="brand" icon="Info"><strong>{i.title}.</strong> {i.detail} <span className="muted">{i.tip}</span></Banner>
      ))}

      {counted.length > 0 && (
        <div className="savings__total">
          <span className="t-label">Keeping these cuts saves</span>
          <span className="t-stat">{fmt(plan.identified, { whole: true })}<small> a month</small></span>
          <span className="t-small">{fmt(plan.identified * 12, { whole: true })} a year</span>
          <span className="grow" />
          {plan.selected.size < counted.length
            ? <button className="btn btn--secondary btn--sm" onClick={() => setPicked(new Set(counted.map((i) => i.id)))}>Switch on all: {fmt(plan.potential, { whole: true })} a month</button>
            : <button className="btn btn--ghost btn--sm" onClick={() => setPicked(new Set())}>Clear</button>}
        </div>
      )}
    </section>
  );
}

function CutRow({ idea, on, onToggle, cat }: { idea: CutIdea; on: boolean; onToggle: () => void; cat: ReturnType<typeof useApp>['categories'][number] | undefined }) {
  const e = EFFORT[idea.effort];
  return (
    <li className={`cut${on ? ' is-on' : ''}`}>
      <label className="cut__row">
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={idea.title} />
        {cat ? <CatTile cat={cat} /> : <IconTile name="Tag" tone="ink" />}
        <span className="cut__main">
          <span className="split">
            <span className="row__title">{idea.title}</span>
            <span className="cut__save num">−{fmt(idea.saving, { whole: true })}<small>/mo</small></span>
          </span>
          <span className="t-small">{idea.detail}</span>
          <span className="cluster">
            <span className={`chip ${e.chip}`}><Icon name={e.icon} size={14} weight="fill" />{e.label}</span>
            {idea.proven && <span className="chip chip--brand"><Icon name="Check" size={14} weight="bold" />Done before</span>}
            <span className="t-xs cut__tip">{idea.tip}</span>
          </span>
        </span>
      </label>
    </li>
  );
}
