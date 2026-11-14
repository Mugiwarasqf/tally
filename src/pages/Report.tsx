import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/data';
import { closeMonth, reopenMonth, setBudget } from '../data/actions';
import { history as typicalSpend, suggestBudgets } from '../domain/analytics/budget';
import { buildReportCard } from '../domain/analytics/report';
import type { CatStatus, Dimension, DimKey } from '../domain/analytics/report';
import { REVIEW_THRESHOLD } from '../domain/categorize/engine';
import { addMonths, cycleLabel, fmtDay } from '../lib/dates';
import { fmt } from '../lib/money';
import { Banner, CardHead, CatTile, IconTile, Meter } from '../ui/components/bits';
import { PeriodPill } from '../ui/components/Period';
import { Sheet, useConfirm, useToast } from '../ui/components/overlay';
import { Icon } from '../ui/icons';
import { ChartCard, ChartTable, Legend } from '../ui/charts/core';
import { Spark } from '../ui/charts/Spark';
import { TrendChart } from '../ui/charts/Trend';
import { Waterfall } from '../ui/charts/Waterfall';
import { Import } from './Import';

const tone = (grade: string) => `g-${grade[0]!.toLowerCase()}`;
const DIM_ORDER: DimKey[] = ['history', 'spending', 'categories', 'savings', 'debt', 'bills'];
const DIM_ICON: Record<DimKey, string> = { history: 'ChartLineUp', spending: 'Gauge', categories: 'Target', savings: 'PiggyBank', debt: 'Scales', bills: 'CalendarBlank' };

export function Report() {
  const app = useApp();
  const { viewKey, setViewKey, planKey, txns, catMap, categories, schedules, coverage, history, reports, settings, budgets, files, cycleFor, cycleWith } = app;
  const toast = useToast();
  const ask = useConfirm();
  const startDay = settings.monthStartDay;
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);

  // Open on the most recent month that has finished: that's the one you reconcile.
  const first = useRef(true);
  useEffect(() => {
    if (first.current && viewKey >= planKey) setViewKey(addMonths(planKey, -1));
    first.current = false;
  }, [viewKey, planKey, setViewKey]);

  const previous = useMemo(() => [...reports].filter((r) => r.month < viewKey).at(-1), [reports, viewKey]);
  const closed = reports.find((r) => r.month === viewKey);
  // No budget for that month? Grade it against what you typically spend (the average of earlier months),
  // and say so, rather than showing nothing.
  const planned = budgets.some((b) => b.month === viewKey);
  const typical = useMemo(
    () => (planned ? [] : [...suggestBudgets(typicalSpend(txns, catMap, viewKey, startDay).spend, categories)].map(([categoryId, amount]) => ({ month: viewKey, categoryId, amount }))),
    [planned, txns, catMap, viewKey, startDay, categories],
  );
  const usedTypical = !planned && typical.length > 0;
  const usual = useMemo(() => typicalSpend(txns, catMap, viewKey, startDay).spend, [txns, catMap, viewKey, startDay]);
  const cycle = useMemo(() => (usedTypical ? cycleWith(viewKey, typical) : cycleFor(viewKey)), [usedTypical, cycleWith, cycleFor, viewKey, typical]);
  const card = useMemo(
    () => buildReportCard({ cycle, txns, cats: catMap, schedules, coverage, history, startDay, previous, typical: usual }),
    [cycle, txns, catMap, schedules, coverage, history, startDay, previous, usual],
  );
  const label = cycleLabel(viewKey, startDay);
  const nextKey = addMonths(viewKey, 1);

  const unreviewed = useMemo(
    () => txns.filter((t) => t.date >= card.start && t.date <= card.end && t.confidence < REVIEW_THRESHOLD && !t.reviewed && t.catSource !== 'manual').length,
    [txns, card.start, card.end],
  );
  const monthFiles = files.filter((f) => f.periodStart && f.periodEnd && f.periodStart <= card.end && f.periodEnd >= card.start);

  const close = async () => {
    if (!card.overall) return;
    if (card.provisional && !(await ask({ title: 'Close a provisional month?', body: `Your statements cover only ${Math.round(card.coverage.share * 100)}% of ${label}. The grade will be saved as provisional.`, confirmLabel: 'Close anyway' }))) return;
    await closeMonth({
      month: viewKey, closedAt: Date.now(), score: card.overall.score, grade: card.overall.grade, planned: card.planned, actual: card.actual,
      provisional: card.provisional, dims: card.dims.map((d) => ({ key: d.key, label: d.label, score: d.score, grade: d.grade })),
    });
    toast(`${label} closed with a ${card.overall.grade}`);
  };

  const applyAll = async () => {
    const chosen = card.suggestions.filter((s) => (picked ?? new Set(card.suggestions.map((x) => x.categoryId))).has(s.categoryId));
    // Carry this month's budgets forward first, so next month isn't left half-empty, then apply the changes.
    const nextHas = new Set(budgets.filter((b) => b.month === nextKey).map((b) => b.categoryId));
    for (const b of budgets.filter((x) => x.month === viewKey)) if (!nextHas.has(b.categoryId)) await setBudget(nextKey, b.categoryId, b.amount);
    for (const s of chosen) await setBudget(nextKey, s.categoryId, s.to);
    toast(`Updated ${chosen.length} budget${chosen.length === 1 ? '' : 's'} for ${cycleLabel(nextKey, startDay)}`);
  };

  const sorted = [...card.dims].sort((a, b) => DIM_ORDER.indexOf(a.key) - DIM_ORDER.indexOf(b.key));
  const selected = picked ?? new Set(card.suggestions.map((s) => s.categoryId));

  return (
    <>
      <div className="page__head">
        <PeriodPill allowFuture={false} />
        <span className="spacer" />
        {closed
          ? <span className="chip chip--good"><Icon name="CheckCircle" size={14} weight="fill" />Closed {new Date(closed.closedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          : !card.hasPlan ? <span className="chip"><Icon name="Target" size={14} />Needs a budget</span>
          : card.provisional ? <span className="chip chip--warn"><Icon name="Clock" size={14} weight="fill" />Provisional</span>
          : <span className="chip chip--brand"><Icon name="CheckCircle" size={14} weight="fill" />Ready to close</span>}
      </div>

      {/* ---------------------------------------------------------- 1. reconcile */}
      <section className="card">
        <CardHead
          title="1 · Reconcile" sub={`Make sure the books for ${label} are complete before you grade them.`}
          action={<button className="btn btn--primary btn--sm" onClick={() => setAdding(true)}><Icon name="UploadSimple" size={16} weight="bold" />Add statements</button>}
        />
        <ul className="checks checks--rec">
          {card.coverage.accounts.length === 0 ? (
            <li className="is-bad"><Icon name="WarningCircle" size={20} weight="fill" /><span><strong>No statements yet.</strong> Add the statements for every account you use.</span></li>
          ) : card.coverage.accounts.map((a) => (
            <li key={a.accountId} className={a.missing.length ? 'is-bad' : 'is-ok'}>
              <Icon name={a.missing.length ? 'WarningCircle' : 'CheckCircle'} size={20} weight="fill" />
              <span className="grow">
                <span><strong>{a.name}</strong> {a.missing.length ? `is missing ${a.missing.map((m) => (m.start === m.end ? fmtDay(m.start) : `${fmtDay(m.start)} – ${fmtDay(m.end)}`)).join(', ')}.` : 'covers every day of the month.'}</span>
                <span className="cover__track cover__track--sm" aria-hidden="true"><i className="cover__have" style={{ left: 0, width: `${a.share * 100}%` }} /></span>
              </span>
              <span className="t-xs num">{Math.round(a.share * 100)}%</span>
            </li>
          ))}
          <li className={monthFiles.some((f) => f.reconciled === false) ? 'is-bad' : monthFiles.length ? 'is-ok' : 'is-bad'}>
            <Icon name={monthFiles.some((f) => f.reconciled === false) || !monthFiles.length ? 'WarningCircle' : 'CheckCircle'} size={20} weight="fill" />
            <span><strong>Statement totals.</strong> {!monthFiles.length ? 'No statements overlap this month.' : monthFiles.some((f) => f.reconciled === false) ? 'One or more statements did not add up to their printed totals.' : `${monthFiles.length} statement${monthFiles.length === 1 ? '' : 's'}, every printed total confirmed.`}</span>
          </li>
          <li className={unreviewed ? 'is-bad' : 'is-ok'}>
            <Icon name={unreviewed ? 'WarningCircle' : 'CheckCircle'} size={20} weight="fill" />
            <span className="grow"><strong>Categories.</strong> {unreviewed ? `${unreviewed} transaction${unreviewed === 1 ? '' : 's'} still uncertain.` : 'Everything is categorised.'}</span>
            {unreviewed > 0 && <a className="btn btn--ghost btn--sm" href="#/transactions?review=1">Review</a>}
          </li>
          <li className="is-ok">
            <Icon name="Briefcase" size={20} weight="fill" />
            <span><strong>Income.</strong> {fmt(card.coverage.share > 0 ? cycle.income : 0, { whole: true })} received{cycle.expectedIncome ? ` of about ${fmt(cycle.expectedIncome, { whole: true })} expected` : ''}.</span>
          </li>
        </ul>
      </section>

      {!card.hasPlan && (
        <Banner tone="brand" icon="Target" action={<a className="btn btn--primary btn--sm" href="#/budget">Set a budget</a>}>
          <strong>There’s no budget for {label} to grade against.</strong> You can still see how the month compared with your history below.
        </Banner>
      )}

      {usedTypical && (
        <Banner tone="brand" icon="Info">
          <strong>No budget was set for {label}, so it’s graded against what you typically spend</strong> (the average of your earlier months). Set budgets ahead of time to grade against a real plan.
        </Banner>
      )}

      {card.hasPlan && card.overall && (
        <div className="bento">
          {/* ------------------------------------------------------ 2. the grade */}
          <section className="hero span-5 gradehero" aria-label="Overall grade">
            <span className="t-eyebrow">2 · Report card · {label}</span>
            <div className="gradehero__row">
              <span className="stamp" aria-label={`Grade ${card.overall.grade}`}>{card.overall.grade}</span>
              <div className="gradehero__side">
                <span className="t-stat">{card.overall.score}<small>/100</small></span>
                <span className="t-small">{card.actual <= card.planned ? 'Finished under plan' : 'Finished over plan'}: {fmt(card.actual, { whole: true })} against {fmt(card.planned, { whole: true })}</span>
                {card.vsUsual !== null && Math.abs(card.vsUsual) >= 1000 && (
                  <span className="chip chip--on-hero"><Icon name={card.vsUsual >= 0 ? 'PiggyBank' : 'TrendUp'} size={14} weight="fill" />{fmt(Math.abs(card.vsUsual), { whole: true })} {card.vsUsual >= 0 ? 'below' : 'above'} your usual spending</span>
                )}
                {card.previous && (
                  <span className="chip chip--on-hero"><Icon name={card.previous.delta >= 0 ? 'TrendUp' : 'TrendDown'} size={14} weight="bold" />{card.previous.delta >= 0 ? '+' : '−'}{Math.abs(card.previous.delta)} vs last month ({card.previous.grade})</span>
                )}
              </div>
            </div>
            {card.provisional && <p className="t-xs">Provisional: your statements cover {Math.round(card.coverage.share * 100)}% of the month, so the plan was scaled to match.</p>}
            <div className="cluster">
              {closed
                ? <button className="btn btn--on-hero btn--sm" onClick={async () => { await reopenMonth(viewKey); toast('Month reopened'); }}><Icon name="ArrowCounterClockwise" size={16} />Reopen</button>
                : <button className="btn btn--mint" onClick={close}><Icon name="CheckCircle" size={18} weight="fill" />Close {label}</button>}
            </div>
          </section>

          <section className="card span-7">
            <CardHead title="How the grade is made" sub="Each part is scored 0–100 by how far you were from plan, then weighted." />
            <ul className="dims">
              {sorted.map((d) => <DimRow key={d.key} d={d} headline={d.key === 'history'} />)}
            </ul>
          </section>
        </div>
      )}

      {/* ---------------------------------------------- 3. versus your history */}
      <ChartCard
        title="3 · This month against your history"
        sub="Each month is compared only with the months before it, so “your usual” gets sharper as you add statements."
        legend={<Legend items={[{ name: label, color: 'var(--c1)' }, { name: 'Earlier months', color: 'var(--c-other)' }, { name: 'Your usual', color: 'var(--ink-2)' }, { name: 'Normal range', color: 'color-mix(in srgb, var(--ink-3) 35%, var(--surface))' }]} />}
        table={<ChartTable head={['Month', 'Spent', 'Your usual', 'Difference', 'Rank']} rows={card.history.points.map((p) => [p.label, fmt(p.complete ? p.spent : (p.projected ?? p.spent)), p.baseline !== undefined ? fmt(p.baseline) : '—', p.deviation !== undefined ? `${p.deviation >= 0 ? '+' : '−'}${Math.round(Math.abs(p.deviation) * 100)}%` : '—', p.rank && p.of ? `${p.rank} of ${p.of}` : '—'])} />}
      >
        <div className="headline">
          <p className="t-title">{card.history.lines[0]}</p>
          {card.history.lines.slice(1).map((l) => <p key={l} className="t-small">{l}</p>)}
        </div>
        <TrendChart points={card.history.points} trend={card.history.trend} selectedKey={viewKey} label={`Monthly spending against your history, ${label} highlighted`} />
        {card.history.trend && (
          <p className="t-xs">
            Trend line: {card.history.trend.direction === 'steady' ? 'steady' : `${card.history.trend.direction} by about ${fmt(Math.abs(card.history.trend.perMonth), { whole: true })} a month`} over {card.history.trend.months} months ({card.history.trend.confidence} confidence).
          </p>
        )}
      </ChartCard>

      {card.history.categories.length > 0 && (
        <section className="card">
          <CardHead title="Which categories moved" sub="Each against its own average of earlier months" />
          <ul className="cattrend">
            {card.history.categories.map((c) => (
              <li key={c.categoryId}>
                <CatTile cat={catMap.get(c.categoryId)} />
                <span className="cattrend__name"><span className="row__title">{catMap.get(c.categoryId)?.name}</span><span className="row__sub">usual {fmt(c.baseline, { whole: true })}</span></span>
                <Spark values={c.series} label={`${catMap.get(c.categoryId)?.name} recent months`} />
                <span className="cattrend__now num">{fmt(c.current, { whole: true })}</span>
                <span className={`delta ${c.direction === 'up' ? 'delta--bad' : c.direction === 'down' ? 'delta--good' : ''}`}>
                  <Icon name={c.direction === 'up' ? 'ArrowUp' : c.direction === 'down' ? 'ArrowDown' : 'ArrowRight'} size={14} weight="bold" />
                  {c.delta >= 0 ? '+' : '−'}{fmt(Math.abs(c.delta), { whole: true })} ({Math.round(Math.abs(c.pct) * 100)}%)
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.hasPlan && (
        <div className="bento">
          {/* ------------------------------------------------ 4. why it differed */}
          <ChartCard
            className="span-7" title="4 · Why it differed from plan" sub="Start at the plan, add each category’s swing, land on what you spent."
            table={<ChartTable head={['Step', 'Amount']} rows={card.waterfall.map((s) => [s.label, s.kind === 'total' ? fmt(s.value) : fmt(s.value, { sign: true })])} />}
          >
            <Waterfall fill steps={card.waterfall} label={`Variance from plan to actual, ${label}`} />
          </ChartCard>

          <section className="card span-5">
            <CardHead title="Category by category" />
            <ul className="catgrades">
              {card.categories.map((c) => (
                <li key={c.categoryId}>
                  <CatTile cat={catMap.get(c.categoryId)} size="sm" />
                  <span className="catgrades__name">
                    <span className="row__title">{catMap.get(c.categoryId)?.name}</span>
                    <span className="row__sub">{c.status === 'unbudgeted' ? `${fmt(c.actual, { whole: true })} unplanned` : `${fmt(c.planned, { whole: true })} → ${fmt(c.actual, { whole: true })}`}</span>
                  </span>
                  <StatusText status={c.status} variance={c.variance} />
                  <span className={`gchip ${tone(c.grade)}`}>{c.grade}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* --------------------------------------- teacher's comment and badges */}
          <section className="card span-7">
            <CardHead title="Teacher’s comment" />
            <blockquote className="comment">
              <Icon name="GraduationCap" size={22} />
              <div className="stack stack--sm">{card.comment.map((p) => <p key={p}>{p}</p>)}</div>
            </blockquote>
          </section>

          <section className="card span-5">
            <CardHead title="Badges" sub={card.badges.length ? `${card.badges.length} earned` : 'None this month'} />
            {card.badges.length ? (
              <ul className="badges">
                {card.badges.map((b) => (
                  <li key={b.key} className="badge"><IconTile name={b.icon} tone="brand" /><span><span className="row__title">{b.label}</span><span className="row__sub" style={{ whiteSpace: 'normal' }}>{b.detail}</span></span></li>
                ))}
              </ul>
            ) : <p className="t-small">Stay on plan, beat your usual spending, hit your savings goal or pay every bill on time to earn badges.</p>}
          </section>

          {/* ------------------------------------------------ next-month changes */}
          {card.suggestions.length > 0 && (
            <section className="card span-12">
              <CardHead title={`Set up ${cycleLabel(nextKey, startDay)}`} sub="Budget changes this month suggests. Untick any you don’t want." action={<button className="btn btn--primary btn--sm" onClick={applyAll}>Apply to next month</button>} />
              <ul className="sugg">
                {card.suggestions.map((s) => (
                  <li key={s.categoryId}>
                    <label className="sugg__row">
                      <input type="checkbox" checked={selected.has(s.categoryId)} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(s.categoryId); else next.delete(s.categoryId); setPicked(next); }} />
                      <CatTile cat={catMap.get(s.categoryId)} size="sm" />
                      <span className="sugg__text"><span className="row__title">{catMap.get(s.categoryId)?.name}: {fmt(s.from, { whole: true })} → {fmt(s.to, { whole: true })}</span><span className="row__sub" style={{ whiteSpace: 'normal' }}>{s.reason}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- grade history */}
      <section className="card">
        <CardHead title="Report card history" sub="Closed months keep their grade, so you can watch it improve." />
        {reports.length || card.overall ? (
          <ol className="gradestrip">
            {[...reports.filter((r) => r.month !== viewKey), ...(closed ? [closed] : card.overall ? [{ month: viewKey, score: card.overall.score, grade: card.overall.grade, provisional: true, planned: 0, actual: 0, closedAt: 0, dims: [] }] : [])]
              .sort((a, b) => a.month.localeCompare(b.month)).slice(-12).map((r) => (
                <li key={r.month} className={`gradecell${r.month === viewKey ? ' is-current' : ''}`}>
                  <span className={`gchip gchip--lg ${tone(r.grade)}`}>{r.grade}</span>
                  <span className="t-xs num">{r.score}</span>
                  <span className="t-xs">{cycleLabel(r.month, startDay, true)}</span>
                </li>
              ))}
          </ol>
        ) : <p className="t-small">Close your first month to start the history.</p>}
      </section>

      {adding && (
        <Sheet wide title={`Add statements for ${label}`} onClose={() => setAdding(false)}>
          <Import />
        </Sheet>
      )}
    </>
  );
}

function DimRow({ d, headline }: { d: Dimension; headline: boolean }) {
  return (
    <li className={`dim${headline ? ' dim--headline' : ''}`}>
      <span className={`gchip gchip--lg ${tone(d.grade)}`}>{d.grade}</span>
      <span className="dim__main">
        <span className="split">
          <span className="row__title"><Icon name={DIM_ICON[d.key]} size={16} /> {d.label}{headline && <span className="chip chip--brand dim__tag">Headline</span>}</span>
          <span className="t-xs num">{d.score} · {d.weight}% of grade</span>
        </span>
        <Meter pct={d.score / 100} label={`${d.label} score`} />
        <span className="t-small">{d.detail}</span>
      </span>
    </li>
  );
}

function StatusText({ status, variance }: { status: CatStatus; variance: number }) {
  const text = status === 'under' ? `${fmt(-variance, { whole: true })} under` : status === 'on' ? 'On plan' : status === 'over' ? `${fmt(variance, { whole: true })} over` : 'No budget';
  const icon = status === 'over' ? 'ArrowUp' : status === 'under' ? 'ArrowDown' : status === 'unbudgeted' ? 'Question' : 'Check';
  return <span className={`t-xs catgrades__status ${status === 'over' ? 'delta--bad' : status === 'under' || status === 'on' ? 'delta--good' : ''}`}><Icon name={icon} size={12} weight="bold" />{text}</span>;
}
