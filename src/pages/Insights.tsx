import { useMemo } from 'react';
import { useApp } from '../app/data';
import { navigate } from '../app/router';
import { byCategory, topMerchants } from '../domain/analytics/aggregate';
import { categoryChanges, dailySpend, weekdayPattern } from '../domain/analytics/insights';
import { addDays, cycleLabel, diffDays, fmtDay, fmtDayYear } from '../lib/dates';
import { fmt } from '../lib/money';
import { everyday } from '../lib/region';
import { CardHead, CatTile, Empty } from '../ui/components/bits';
import { PeriodPill } from '../ui/components/Period';
import { Icon } from '../ui/icons';
import { RankedBars } from '../ui/charts/Bars';
import { ColumnChart } from '../ui/charts/Columns';
import { ChartCard, ChartTable } from '../ui/charts/core';
import { Heatmap } from '../ui/charts/Heatmap';

export function Insights() {
  const { txns, catMap, settings, viewKey, lastData, today, flags } = useApp();
  const startDay = settings.monthStartDay;
  const to = lastData && lastData < today ? lastData : today;
  const from90 = addDays(to, -90);
  const heatFrom = addDays(to, -181);

  const changes = useMemo(() => categoryChanges(txns, catMap, viewKey, startDay), [txns, catMap, viewKey, startDay]);
  const window90 = useMemo(() => txns.filter((t) => t.date >= from90 && t.date <= to), [txns, from90, to]);
  const merchants = useMemo(() => topMerchants(window90, catMap, 8), [window90, catMap]);
  const weekday = useMemo(() => weekdayPattern(txns, catMap, from90, to), [txns, catMap, from90, to]);
  const daily = useMemo(() => dailySpend(txns, catMap, heatFrom, to), [txns, catMap, heatFrom, to]);
  const cats90 = useMemo(() => byCategory(window90, catMap), [window90, catMap]);

  if (!txns.length) return <section className="card"><Empty icon="Lightbulb" title="Insights need data">Import a few months of statements and patterns will start to appear here.</Empty></section>;

  const maxDelta = Math.max(1, ...changes.map((c) => Math.abs(c.delta)));
  const peak = weekday.reduce((a, b) => (b.average > a.average ? b : a), weekday[0]!);
  const spendDays = [...daily.values()].filter((v) => v > 0).length;
  const last30 = diffDays(addDays(to, -29), to) + 1;
  const noSpend = last30 - [...daily.entries()].filter(([d, v]) => d >= addDays(to, -29) && v > 0).length;
  const biggest = [...window90].filter((t) => t.amount < 0 && catMap.get(t.categoryId)?.kind === 'expense').sort((a, b) => a.amount - b.amount).slice(0, 4);

  return (
    <>
      <div className="page__head"><PeriodPill allowFuture={false} /></div>
      <div className="bento">
        <section className="card span-7">
          <CardHead title="What changed" sub={`${cycleLabel(viewKey, startDay)} compared with the period before. Biggest movers in pounds.`} />
          {changes.length === 0 ? <p className="t-small">Nothing moved by more than {fmt(everyday(5), { whole: true })} in any category.</p> : (
            <ul className="diverge" aria-label="Change in spending by category">
              {changes.map((c) => {
                const up = c.delta > 0;
                const w = (Math.abs(c.delta) / maxDelta) * 50;
                return (
                  <li key={c.categoryId}>
                    <button className="diverge__row" onClick={() => navigate('/transactions', { cat: c.categoryId, cycle: viewKey })}>
                      <CatTile cat={catMap.get(c.categoryId)} size="sm" />
                      <span className="diverge__name">{catMap.get(c.categoryId)?.name}</span>
                      <span className="diverge__track" aria-hidden="true">
                        <i className={up ? 'is-up' : 'is-down'} style={up ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                      </span>
                      <span className={`diverge__val num ${up ? 'delta--bad' : 'delta--good'}`}>
                        <Icon name={up ? 'ArrowUp' : 'ArrowDown'} size={14} weight="bold" />{fmt(Math.abs(c.delta), { whole: true })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="legend"><span className="legend__item"><i className="legend__sw" style={{ background: 'var(--div-down)' }} />Spent less</span><span className="legend__item"><i className="legend__sw" style={{ background: 'var(--div-up)' }} />Spent more</span></div>
        </section>

        <section className="card span-5">
          <CardHead title="Worth a second look" sub="Doubled-up and unusually large payments" />
          {flags.length === 0 ? <p className="t-small">Nothing odd in the last 45 days.</p> : (
            <div className="list">
              {flags.slice(0, 5).map((f) => (
                <button key={f.txn.id} className="row" onClick={() => navigate('/transactions', { q: f.txn.merchant })}>
                  <span className="tile tile--ink"><Icon name={f.kind === 'double' ? 'Rows' : 'Warning'} size={20} /></span>
                  <span className="row__main"><span className="row__title">{f.txn.merchant}</span><span className="row__sub" style={{ whiteSpace: 'normal' }}>{f.note} · {fmtDay(f.txn.date)}</span></span>
                  <span className="row__end row__amount">{fmt(-f.txn.amount)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <ChartCard
          className="span-5" title="Your week" sub={`${peak.day} is your priciest day, about ${fmt(peak.average, { whole: true })} on average.`}
          table={<ChartTable head={['Day', 'Average spent']} rows={weekday.map((d) => [d.day, fmt(d.average)])} />}
        >
          <ColumnChart label="Average spending by weekday" height={220} series={[{ name: 'Average spent', color: 'var(--c1)' }]} data={weekday.map((d) => ({ key: d.day, label: d.day, values: [d.average] }))} selectedKey={peak.day} />
        </ChartCard>

        <ChartCard
          className="span-7" title="Spending calendar" sub={`Last six months. ${noSpend} no-spend day${noSpend === 1 ? '' : 's'} in the past 30.`}
          table={<ChartTable head={['Date', 'Spent']} rows={[...daily.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 60).map(([d, v]) => [fmtDayYear(d), fmt(v)])} />}
        >
          <Heatmap values={daily} from={heatFrom} to={to} label="Daily spending calendar" />
          <span className="t-xs">{spendDays} days with spending.</span>
        </ChartCard>

        <section className="card span-7">
          <CardHead title="Top merchants" sub="Last 90 days" />
          <RankedBars
            label="Spending by merchant"
            rows={merchants.map((m) => ({ key: m.mkey, label: m.merchant, value: m.amount, lead: <CatTile cat={catMap.get(m.categoryId)} />, sub: `${m.count} payment${m.count === 1 ? '' : 's'}`, onClick: () => navigate('/transactions', { q: m.merchant }) }))}
          />
        </section>

        <section className="card span-5">
          <CardHead title="Biggest payments" sub="Last 90 days" />
          <div className="list">
            {biggest.map((t) => (
              <button key={t.id} className="row" onClick={() => navigate('/transactions', { q: t.merchant })}>
                <CatTile cat={catMap.get(t.categoryId)} />
                <span className="row__main"><span className="row__title">{t.merchant}</span><span className="row__sub">{fmtDayYear(t.date)}</span></span>
                <span className="row__end row__amount">{fmt(-t.amount)}</span>
              </button>
            ))}
          </div>
          <p className="t-xs">Across {cats90.length} categories.</p>
        </section>
      </div>
    </>
  );
}
