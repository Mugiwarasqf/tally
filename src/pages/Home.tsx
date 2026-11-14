import { useMemo } from 'react';
import { useApp } from '../app/data';
import { navigate } from '../app/router';
import { setDemo } from '../data/db';
import { saveSettings } from '../data/settings';
import { byCategory } from '../domain/analytics/aggregate';
import { staleDays } from '../domain/analytics/coverage';
import { buildIncomeFlow } from '../domain/analytics/flow';
import { dueSoon } from '../domain/analytics/recurring';
import { REVIEW_THRESHOLD } from '../domain/categorize/engine';
import { addDays, addMonths, cycleLabel, diffDays, eachDay, fmtDay, fmtRelative, makeDate } from '../lib/dates';
import { fmt } from '../lib/money';
import { Banner, CardHead, CatTile, HeroMoney, IconTile, Meter, StatusChip } from '../ui/components/bits';
import { PeriodPill } from '../ui/components/Period';
import { ProfileForm } from '../ui/components/Profile';
import { Icon } from '../ui/icons';
import { RankedBars } from '../ui/charts/Bars';
import { ColumnChart } from '../ui/charts/Columns';
import { ChartCard, ChartTable, Legend } from '../ui/charts/core';
import { FlowChart, SINK_COLOR } from '../ui/charts/Flow';

export function Home() {
  const { txns } = useApp();
  return txns.length ? <Dashboard /> : <Onboarding />;
}

const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n) ? 0 : n % 10] ?? 'th'}`;

function Dashboard() {
  const app = useApp();
  const { cycle, txns, catMap, settings, today, coverage, recurring, debts, plan, flags, schedules, income, savingsFor } = app;
  const startDay = settings.monthStartDay;
  const missed = schedules.filter((s) => s.missedInRow > 0);

  const inCycle = useMemo(() => txns.filter((t) => t.date >= cycle.start && t.date <= cycle.end), [txns, cycle.start, cycle.end]);
  const review = useMemo(() => txns.filter((t) => t.confidence < REVIEW_THRESHOLD && !t.reviewed && t.catSource !== 'manual').length, [txns]);
  const stale = staleDays(coverage, today);
  const label = cycleLabel(cycle.key, startDay);

  // Daily chart plots FLEXIBLE spending only: it's what the daily allowance line applies to, and a
  // one-off rent payment on the 1st would otherwise flatten every other day into nothing.
  const daily = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of inCycle) {
      const c = catMap.get(t.categoryId);
      if (c?.kind === 'expense' && !c.fixed) m.set(t.date, (m.get(t.date) ?? 0) - t.amount);
    }
    return [...eachDay(cycle.start, cycle.asOf)].map((d) => ({ key: d, label: String(Number(d.slice(8, 10))), title: `${fmtRelative(d, today)} · ${fmtDay(d)}`, values: [Math.max(0, m.get(d) ?? 0)] }));
  }, [inCycle, catMap, cycle.start, cycle.asOf, today]);

  const top = useMemo(() => byCategory(inCycle, catMap).slice(0, 5), [inCycle, catMap]);
  const flow = useMemo(() => buildIncomeFlow({ txns: inCycle, cats: catMap, cycle, income }), [inCycle, catMap, cycle, income]);
  const kept = cycle.income - cycle.spent - cycle.saved - cycle.debtPaid;
  const budgetLines = cycle.lines.filter((l) => !l.category.fixed && l.budget > 0).sort((a, b) => b.pct - a.pct).slice(0, 5);

  const flowRows = useMemo(() => {
    if (!flow) return [];
    return flow.sinks.flatMap((k) => flow.sources.map((s) => [s.label, k.label, fmt((k.value * s.value) / flow.total)]));
  }, [flow]);

  // Bills and debt payments due in the next 30 days, counted from today (not from the last statement).
  const upcoming = useMemo(() => {
    const from = today;
    const to = addDays(from, 30);
    const items: Array<{ id: string; icon: string; name: string; date: string; amount: number; projected?: boolean }> = [];
    for (const u of dueSoon(recurring, from)) items.push({ id: u.recurring.key, icon: catMap.get(u.recurring.categoryId)?.icon ?? 'ArrowsClockwise', name: u.recurring.merchant, date: u.date, amount: u.recurring.amount, projected: u.projected });
    for (const d of debts) {
      if (!d.dueDay) continue;
      for (const k of [from.slice(0, 7), addMonths(from.slice(0, 7), 1)]) {
        const date = makeDate(Number(k.slice(0, 4)), Number(k.slice(5, 7)), Math.min(d.dueDay, 28));
        if (date >= from && date <= to) items.push({ id: `${d.id}${k}`, icon: 'Scales', name: `${d.name} payment`, date, amount: plan?.plan.months[0]?.payments[d.id] ?? d.minPayment });
      }
    }
    return items.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  }, [recurring, debts, plan, today, catMap]);

  const debtPaidShare = plan && plan.debts.length ? 1 - plan.totalBalance / Math.max(1, plan.debts.reduce((s, d) => s + d.original, 0)) : 0;

  // Declared rent that never shows up in a fully-covered month: it's probably paid from an account we haven't seen.
  const rentGaps = useMemo(() => {
    const rent = settings.profile?.rentAmount;
    if (!rent) return [];
    return app.history
      .filter((m) => m.complete && !txns.some((t) => t.date >= m.start && t.date <= m.end && t.amount < 0 && t.categoryId === 'housing' && Math.abs(-t.amount - rent) <= Math.max(100, rent * 0.05)))
      .map((m) => m.label);
  }, [app.history, txns, settings.profile?.rentAmount]);

  // Offer to start the budget month on payday, so every cycle begins with money in the bank.
  const payday = income.payday;
  const savings = useMemo(() => savingsFor(cycle.key), [savingsFor, cycle.key]);
  const offerCuts = cycle.phase !== 'past' && savings.potential >= 2000 && !settings.dismissedHints?.includes('cuts') && cycle.budgetTotal === 0;
  const offerPayday = payday !== undefined && payday <= 28 && payday !== startDay && !settings.dismissedHints?.includes('payday');

  return (
    <>
      <div className="page__head">
        <PeriodPill />
        <span className="spacer" />
        {cycle.phase === 'current' && <span className="chip"><Icon name="CalendarBlank" size={14} />{Math.max(0, diffDays(cycle.asOf, cycle.end))} days left</span>}
      </div>

      {!settings.profile?.payAmount && (
        <section className="card">
          <CardHead title="First, tell Tally about your pay and rent" sub="Two numbers you know better than any statement. Everything else is built on them." />
          <ProfileForm />
        </section>
      )}
      {stale !== null && stale > 7 && cycle.phase !== 'past' && (
        <Banner tone="warn" icon="UploadSimple" action={<a className="btn btn--secondary btn--sm" href="#/import">Add statement</a>}>
          <strong>Your latest statement ends {stale} days ago.</strong> Add the newest one to see today’s numbers.
        </Banner>
      )}
      {rentGaps.length > 0 && !settings.dismissedHints?.includes('rent-gaps') && (
        <Banner
          tone="warn" icon="House"
          action={<span className="cluster"><a className="btn btn--secondary btn--sm" href="#/import">Import that account</a><button className="btn btn--ghost btn--sm" onClick={() => saveSettings({ dismissedHints: [...(settings.dismissedHints ?? []), 'rent-gaps'] })}>Dismiss</button></span>}
        >
          <strong>No {fmt(settings.profile!.rentAmount!, { whole: true })} rent payment in {rentGaps.join(', ')}.</strong> If you paid it from another account, import that account’s statements too; otherwise those months look cheaper than they were.
        </Banner>
      )}
      {offerCuts && (
        <Banner
          tone="good" icon="PiggyBank"
          action={<span className="cluster"><a className="btn btn--primary btn--sm" href="#/budget">See the cut list</a><button className="btn btn--ghost btn--sm" onClick={() => saveSettings({ dismissedHints: [...(settings.dismissedHints ?? []), 'cuts'] })}>Not now</button></span>}
        >
          <strong>You could save about {fmt(savings.potential, { whole: true })} a month</strong> by trimming {savings.ideas.filter((i) => i.counted).length} things, {fmt(savings.potential * 12, { whole: true })} a year.
        </Banner>
      )}
      {offerPayday && (
        <Banner
          tone="brand" icon="CalendarBlank"
          action={<span className="cluster"><button className="btn btn--primary btn--sm" onClick={() => saveSettings({ monthStartDay: payday })}>Start on the {ordinal(payday)}</button><button className="btn btn--ghost btn--sm" onClick={() => saveSettings({ dismissedHints: [...(settings.dismissedHints ?? []), 'payday'] })}>Not now</button></span>}
        >
          <strong>Your pay lands around the {ordinal(payday)}.</strong> Starting each budget month then means every period begins with your income in the bank.
        </Banner>
      )}

      <div className="bento">
        {/* ---------------------------------------------------------------- hero */}
        <section className="hero span-6" aria-label="Safe to spend">
          {cycle.phase === 'current' && !cycle.stale && cycle.perDay !== null ? (
            <>
              <span className="t-eyebrow">Safe to spend today</span>
              <HeroMoney pence={Math.max(0, cycle.safeToday ?? 0)} />
              <p className="t-small">
                {(cycle.safeToday ?? 0) < 0
                  ? `You’re ${fmt(-(cycle.safeToday ?? 0))} over today’s allowance. Tomorrow’s resets to about ${fmt(Math.max(0, cycle.perDay))}.`
                  : `About ${fmt(Math.max(0, cycle.perDay))} a day for the next ${cycle.daysLeft} days.`}
              </p>
              <div className="split">
                <span className="cluster">
                  <StatusChip status={cycle.status} onHero label={cycle.spentFlex > cycle.budgetFlex ? 'Over budget' : undefined} />
                  {cycle.incomeLed && <span className="chip chip--on-hero"><Icon name="Coins" size={14} weight="fill" />Based on your income</span>}
                </span>
                <span className="t-small">{fmt(cycle.spentFlex, { whole: true })} of {fmt(cycle.budgetFlex, { whole: true })}</span>
              </div>
              <Meter pct={cycle.budgetFlex ? cycle.spentFlex / cycle.budgetFlex : 0} onHero label="Flexible budget used" />
              <div className="cluster">
                {income.nextPay && (
                  <span className="chip chip--on-hero"><Icon name="CalendarBlank" size={14} weight="fill" />Next pay {fmt(income.nextPay.amount, { whole: true })} · {fmtRelative(income.nextPay.date, today).toLowerCase()}</span>
                )}
                {cycle.paydays > 1 && <span className="chip chip--on-hero">{cycle.paydays} paydays this period</span>}
              </div>
              {cycle.budgetTotal > 0 && (
                <p className="t-xs">
                  {cycle.projected > cycle.budgetTotal
                    ? `At this pace you’ll finish about ${fmt(cycle.projected - cycle.budgetTotal, { whole: true })} over budget.`
                    : `At this pace you’ll finish about ${fmt(cycle.budgetTotal - cycle.projected, { whole: true })} under budget.`}
                </p>
              )}
            </>
          ) : cycle.phase === 'past' || cycle.stale ? (
            <>
              <span className="t-eyebrow">{cycle.stale ? `Statements run to ${fmtDay(cycle.asOf)}` : `${label} recap`}</span>
              <HeroMoney pence={kept} />
              <p className="t-small">
                {kept >= 0 ? 'Kept' : 'Overspent'} after {fmt(cycle.spent, { whole: true })} spending{cycle.debtPaid ? `, ${fmt(cycle.debtPaid, { whole: true })} debt payments` : ''}{cycle.saved ? ` and ${fmt(cycle.saved, { whole: true })} saved` : ''}, from {fmt(cycle.income, { whole: true })} income.
              </p>
              <div className="cluster">
                {cycle.stale && <a className="btn btn--on-hero btn--sm" href="#/import"><Icon name="UploadSimple" size={16} />Add newer statement</a>}
                <a className="btn btn--on-hero btn--sm" href="#/budget"><Icon name="Target" size={16} />Plan next month</a>
              </div>
            </>
          ) : (
            <>
              <span className="t-eyebrow">{cycle.phase === 'future' ? `Plan ${label}` : 'No budget yet'}</span>
              <HeroMoney pence={cycle.spent} />
              <p className="t-small">Spent so far this period. Set a budget to see how much is safe to spend each day.</p>
              <div className="cluster"><a className="btn btn--on-hero" href="#/budget"><Icon name="Target" size={18} />Set up a budget</a></div>
            </>
          )}
        </section>

        {/* -------------------------------------------------------- income stem */}
        <ChartCard
          className="span-6" title="Your income stem"
          sub={flow ? (flow.mode === 'actual' ? `${fmt(flow.total, { whole: true })} in during ${label}` : `Plan for ${label}. Pay hasn’t landed yet.`) : label}
          legend={flow ? <Legend items={flow.sinks.map((s) => ({ name: s.label, color: SINK_COLOR[s.key] }))} /> : undefined}
          table={flow ? <ChartTable head={['From', 'To', 'Amount']} rows={flowRows} /> : undefined}
        >
          {flow ? <FlowChart sources={flow.sources} sinks={flow.sinks} label={`Where income goes, ${label}`} /> : <p className="t-small">Nothing recorded in this period yet.</p>}
        </ChartCard>

        {/* ----------------------------------------------------- daily spending */}
        <ChartCard
          className="span-7" title="Daily spending" sub={cycle.perDay ? `Flexible spending. The dotted line is your allowance of ${fmt(cycle.perDay)} a day.` : 'Flexible spending per day. Bills and transfers are excluded.'}
          table={<ChartTable head={['Day', 'Spent']} rows={daily.map((d) => [d.title, fmt(d.values[0]!)])} />}
        >
          <ColumnChart fill height={280} data={daily} series={[{ name: 'Spent', color: 'var(--c1)' }]} label={`Daily flexible spending, ${label}`} reference={cycle.perDay && cycle.perDay > 0 ? { value: cycle.perDay, name: 'Daily allowance' } : undefined} />
        </ChartCard>

        {/* ------------------------------------------------------ top categories */}
        <section className="card span-5">
          <CardHead title="Top categories" action={<a className="btn btn--ghost btn--sm" href="#/transactions">See all</a>} />
          {top.length ? (
            <RankedBars
              label="Spending by category"
              rows={top.map((c) => ({
                key: c.categoryId, label: catMap.get(c.categoryId)?.name ?? 'Other', value: c.amount,
                lead: <CatTile cat={catMap.get(c.categoryId)} />,
                sub: `${Math.round((c.amount / Math.max(1, cycle.spent)) * 100)}% of spending · ${c.count} payment${c.count === 1 ? '' : 's'}`,
                onClick: () => navigate('/transactions', { cat: c.categoryId, cycle: cycle.key }),
              }))}
            />
          ) : <p className="t-small">No spending in this period.</p>}
        </section>

        {/* ------------------------------------------------------- budget status */}
        <section className="card span-7">
          <CardHead title="Budget check" sub="Flexible categories, most used first" action={<a className="btn btn--ghost btn--sm" href="#/budget">Edit budget</a>} />
          {budgetLines.length ? (
            <div className="list">
              {budgetLines.map((l) => (
                <a key={l.category.id} className="row row--hover row--top" href="#/budget">
                  <CatTile cat={l.category} />
                  <span className="row__main">
                    <span className="split"><span className="row__title">{l.category.name}</span>
                      <span className="t-small num">{fmt(l.spent, { whole: true })} of {fmt(l.budget, { whole: true })}</span></span>
                    <Meter pct={l.pct} status={l.status} label={`${l.category.name} budget used`} />
                  </span>
                  <span className="row__end t-small row__status">
                    {l.remaining < 0
                      ? <span className="chip chip--critical"><Icon name="WarningCircle" size={14} weight="fill" />{fmt(-l.remaining, { whole: true })} over</span>
                      : l.status === 'over' || l.status === 'watch'
                        ? <span className={`chip ${l.status === 'over' ? 'chip--serious' : 'chip--warn'}`}><Icon name="TrendUp" size={14} weight="bold" />Ahead of pace</span>
                        : <span>{fmt(l.remaining, { whole: true })} left</span>}
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <Banner tone="brand" icon="Target" action={<a className="btn btn--primary btn--sm" href="#/budget">Set budget</a>}>
              No budget for {label} yet. Set a savings goal and Tally will work out what to cut.
            </Banner>
          )}
        </section>

        {/* ---------------------------------------------------------- upcoming */}
        <section className="card span-5">
          <CardHead title="Coming up" sub="Next 30 days" action={<a className="btn btn--ghost btn--sm" href="#/recurring">All recurring</a>} />
          {upcoming.length ? (
            <div className="list">
              {upcoming.map((u) => (
                <div key={u.id} className="row">
                  <IconTile name={u.icon} tone="ink" />
                  <span className="row__main"><span className="row__title">{u.name}</span><span className="row__sub">{fmtRelative(u.date, today)}{u.projected ? ' · expected' : ''}</span></span>
                  <span className="row__end row__amount">{fmt(u.amount)}</span>
                </div>
              ))}
            </div>
          ) : <p className="t-small">Nothing due in the next 30 days. Missing a bill? <a href="#/recurring">Add it on the Recurring page</a>.</p>}
        </section>

        {/* ------------------------------------------------------------ debt */}
        <section className="card span-4">
          <CardHead title="Debt" action={<a className="btn btn--ghost btn--sm" href="#/debts">Plan</a>} />
          {plan && plan.totalBalance > 0 ? (
            <>
              <div className="stat"><span className="stat__label">Outstanding</span><span className="stat__value">{fmt(plan.totalBalance, { whole: true })}</span></div>
              <Meter pct={debtPaidShare} label="Debt repaid" status="ontrack" />
              <p className="t-small">
                {plan.debtFree ? <>Debt-free by <strong>{cycleLabel(plan.debtFree, 1)}</strong> paying {fmt(plan.monthly, { whole: true })} a month.</> : 'Payments don’t yet outrun interest. Open the plan to fix that.'}
              </p>
            </>
          ) : (
            <p className="t-small">{debts.length ? 'All debts cleared. Well done.' : 'Add what you owe and get a payment plan that fits your budget.'}</p>
          )}
        </section>

        {/* -------------------------------------------------------- attention */}
        <section className="card span-4">
          <CardHead title="Needs a look" />
          <div className="list">
            <a className="row row--hover" href="#/transactions?review=1">
              <IconTile name="Tag" tone="ink" />
              <span className="row__main"><span className="row__title">{review ? `${review} to categorise` : 'All categorised'}</span><span className="row__sub">{review ? 'Confirm in one tap' : 'Nothing waiting'}</span></span>
              <Icon name="CaretRight" size={18} />
            </a>
            <a className="row row--hover" href={schedules.some((s) => s.source === 'debt' && s.missedInRow) ? '#/debts' : '#/recurring'}>
              <IconTile name="WarningCircle" tone="ink" />
              <span className="row__main"><span className="row__title">{missed.length ? `${missed.length} missed payment${missed.length === 1 ? '' : 's'}` : 'No missed payments'}</span><span className="row__sub">{missed.length ? missed.map((s) => s.label).slice(0, 2).join(', ') : 'Bills and debts on schedule'}</span></span>
              <Icon name="CaretRight" size={18} />
            </a>
            <a className="row row--hover" href="#/insights">
              <IconTile name="Warning" tone="ink" />
              <span className="row__main"><span className="row__title">{flags.length ? `${flags.length} unusual charge${flags.length === 1 ? '' : 's'}` : 'No unusual charges'}</span><span className="row__sub">Doubles and big one-offs</span></span>
              <Icon name="CaretRight" size={18} />
            </a>
          </div>
        </section>

        <section className="card span-4">
          <CardHead title="Income" action={<a className="btn btn--ghost btn--sm" href="#/budget">Details</a>} />
          {income.streams.length ? (
            <div className="list">
              {income.streams.slice(0, 3).map((s) => (
                <div className="row" key={s.key}>
                  <IconTile name="Briefcase" tone="ink" size="sm" />
                  <span className="row__main"><span className="row__title">{s.label}</span><span className="row__sub">{s.cadence === 'fortnightly' ? 'Every two weeks' : s.cadence === 'weekly' ? 'Weekly' : `Monthly${s.payday ? `, around the ${ordinal(s.payday)}` : ''}`}</span></span>
                  <span className="row__end row__amount">{fmt(s.amount, { whole: true })}</span>
                </div>
              ))}
              <p className="t-xs">About {fmt(income.expectedMonthly, { whole: true })} a month to plan on.</p>
            </div>
          ) : <p className="t-small">No regular pay found yet. It’s picked out by its rhythm: weekly, every two weeks or monthly.</p>}
        </section>
      </div>
    </>
  );
}

function Onboarding() {
  return (
    <div className="onboard">
      <section className="hero onboard__hero">
        <span className="t-eyebrow">Welcome to Tally</span>
        <h2 className="t-display onboard__title">Your money, finally in one picture.</h2>
        <p className="onboard__lead">Drop in your bank statements. Tally reads them on this device, finds your pay, sorts every payment, and turns it into a budget and a debt plan that actually fits.</p>
        <div className="cluster">
          <a className="btn btn--mint" href="#/import"><Icon name="UploadSimple" size={20} weight="bold" />Import a statement</a>
          <button className="btn btn--on-hero" onClick={() => setDemo(true)}><Icon name="Sparkle" size={18} />Explore with sample data</button>
        </div>
      </section>
      <div className="steps">
        {[
          { icon: 'FilePdf', t: 'Attach statements', d: 'HSBC PDFs, plus CSV, OFX or QIF from any bank. Add as many months as you like.' },
          { icon: 'Briefcase', t: 'Income first', d: 'Weekly, fortnightly or monthly pay is spotted by its rhythm, and everything you spend is drawn from it.' },
          { icon: 'Target', t: 'Plan the month', d: 'A daily allowance, budgets, and a repayment plan for any debt you owe.' },
          { icon: 'ShieldCheck', t: 'Private by design', d: 'Nothing is uploaded. Your data lives in this browser and nowhere else.' },
        ].map((s) => (
          <div className="step" key={s.t}>
            <IconTile name={s.icon} tone="brand" size="lg" />
            <h3 className="t-h2">{s.t}</h3>
            <p className="t-small">{s.d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
