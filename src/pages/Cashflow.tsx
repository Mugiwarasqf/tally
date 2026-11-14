import { useMemo, useState } from 'react';
import { useApp } from '../app/data';
import { navigate } from '../app/router';
import { balanceSeries, buildSeries, byCategory, totals } from '../domain/analytics/aggregate';
import type { Grain, Totals } from '../domain/analytics/aggregate';
import { addDays, diffDays, fmtDay, fmtDayYear } from '../lib/dates';
import type { ISODate } from '../lib/dates';
import { fmt } from '../lib/money';
import { CatTile, Segmented } from '../ui/components/bits';
import { Icon } from '../ui/icons';
import { RankedBars, SegmentedBar } from '../ui/charts/Bars';
import { ColumnChart } from '../ui/charts/Columns';
import { ChartCard, ChartTable } from '../ui/charts/core';
import { LineChart } from '../ui/charts/Lines';
import { Spark } from '../ui/charts/Spark';

type Range = '3m' | '6m' | '12m' | 'all';
const DAYS: Record<Exclude<Range, 'all'>, number> = { '3m': 92, '6m': 183, '12m': 365 };

function Delta({ now, prev, goodWhenUp }: { now: number; prev: number; goodWhenUp: boolean }) {
  if (!prev) return <span className="t-xs">No earlier period to compare</span>;
  const pct = Math.round(((now - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return <span className="t-xs">No change on the previous period</span>;
  const up = pct > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`delta ${good ? 'delta--good' : 'delta--bad'}`}>
      <Icon name={up ? 'ArrowUp' : 'ArrowDown'} size={14} weight="bold" />
      {Math.abs(pct)}% <span className="t-xs">vs previous</span>
    </span>
  );
}

export function Cashflow() {
  const { txns, catMap, accounts, settings, today, lastData } = useApp();
  const startDay = settings.monthStartDay;
  const [grain, setGrain] = useState<Grain>('week');
  const [range, setRange] = useState<Range>('6m');

  const to: ISODate = lastData && lastData < today ? lastData : today;
  const earliest = txns.length ? txns[txns.length - 1]!.date : to;
  const from: ISODate = range === 'all' ? earliest : addDays(to, -DAYS[range] + 1) < earliest ? earliest : addDays(to, -DAYS[range] + 1);
  const span = diffDays(from, to) + 1;
  const g: Grain = grain === 'day' && span > 100 ? 'week' : grain;

  const inRange = useMemo(() => txns.filter((t) => t.date >= from && t.date <= to), [txns, from, to]);
  const prevRange = useMemo(() => {
    const pTo = addDays(from, -1);
    const pFrom = addDays(pTo, -(span - 1));
    return txns.filter((t) => t.date >= pFrom && t.date <= pTo);
  }, [txns, from, span]);
  const now = useMemo(() => totals(inRange, catMap), [inRange, catMap]);
  const prev = useMemo(() => totals(prevRange, catMap), [prevRange, catMap]);
  const series = useMemo(() => buildSeries(txns, catMap, g, from, to, startDay), [txns, catMap, g, from, to, startDay]);
  const bal = useMemo(() => balanceSeries(txns, accounts, from, to), [txns, accounts, from, to]);
  const cats = useMemo(() => byCategory(inRange, catMap).slice(0, 8), [inRange, catMap]);

  const spark = (k: keyof Totals) => series.map((b) => b[k]);
  const tiles: Array<{ k: keyof Totals; label: string; goodUp: boolean; color: string }> = [
    { k: 'income', label: 'Income', goodUp: true, color: 'var(--c3)' },
    { k: 'spent', label: 'Spent', goodUp: false, color: 'var(--c1)' },
    { k: 'saved', label: 'Saved', goodUp: true, color: 'var(--c3)' },
    { k: 'left', label: 'Left over', goodUp: true, color: 'var(--c6)' },
  ];
  const unit = g === 'day' ? 'Day' : g === 'week' ? 'Week' : 'Month';

  return (
    <>
      <div className="filters filters--head">
        <Segmented<Grain> label="Group by" value={g} onChange={setGrain} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
        <Segmented<Range> label="Time range" value={range} onChange={setRange} options={[{ value: '3m', label: '3 months' }, { value: '6m', label: '6 months' }, { value: '12m', label: '12 months' }, { value: 'all', label: 'All' }]} />
        <span className="t-small cashflow__range">{fmtDayYear(from)} – {fmtDayYear(to)}</span>
      </div>

      <div className="stats stats--4 tiles">
        {tiles.map((t) => (
          <section className="card tile-card" key={t.k}>
            <span className="stat__label">{t.label}</span>
            <div className="split">
              <span className="t-stat">{fmt(now[t.k], { whole: true })}</span>
              <Spark values={spark(t.k)} label={`${t.label} per ${unit.toLowerCase()}`} />
            </div>
            <Delta now={now[t.k]} prev={prev[t.k]} goodWhenUp={t.goodUp} />
          </section>
        ))}
      </div>

      <div className="bento">
        <ChartCard
          className="span-12" title="Income and spending" sub={`Per ${unit.toLowerCase()}, transfers between your own accounts excluded.`}
          legend={<div className="legend"><span className="legend__item"><i className="legend__sw" style={{ background: 'var(--c3)' }} />Income</span><span className="legend__item"><i className="legend__sw" style={{ background: 'var(--c1)' }} />Spent</span></div>}
          table={<ChartTable head={[unit, 'Income', 'Spent', 'Left over']} rows={series.map((b) => [b.label, fmt(b.income), fmt(b.spent), fmt(b.left, { sign: true })])} />}
        >
          <ColumnChart
            label={`Income and spending per ${unit.toLowerCase()}`}
            series={[{ name: 'Income', color: 'var(--c3)' }, { name: 'Spent', color: 'var(--c1)' }]}
            data={series.map((b) => ({ key: b.key, label: b.label, title: g === 'month' ? b.label : `${fmtDay(b.start)}${g === 'week' ? ` – ${fmtDay(b.end)}` : ''}`, values: [Math.max(0, b.income), Math.max(0, b.spent)] }))}
          />
        </ChartCard>

        {bal.length > 1 && (
          <ChartCard
            className="span-12" title="Balance" sub="Combined across accounts, from the balances printed on your statements."
            table={<ChartTable head={['Date', 'Balance']} rows={bal.filter((_, i) => i % Math.max(1, Math.round(bal.length / 60)) === 0).map((p) => [fmtDayYear(p.date), fmt(p.balance)])} />}
          >
            <LineChart
              label="Balance over time" endLabel
              labels={bal.map((p) => fmtDay(p.date))} titles={bal.map((p) => fmtDayYear(p.date))}
              series={[{ name: 'Balance', color: 'var(--c1)', values: bal.map((p) => p.balance), area: true }]}
            />
          </ChartCard>
        )}

        <section className="card span-7">
          <div className="card__head"><div><h2>Where it went</h2><p className="t-small">{fmt(now.spent)} across {cats.length} top categories</p></div></div>
          <RankedBars
            label="Spending by category"
            rows={cats.map((c) => ({
              key: c.categoryId, label: catMap.get(c.categoryId)?.name ?? 'Other', value: c.amount, lead: <CatTile cat={catMap.get(c.categoryId)} />,
              sub: `${Math.round((c.amount / Math.max(1, now.spent)) * 100)}% of spending`,
              onClick: () => navigate('/transactions', { cat: c.categoryId }),
            }))}
          />
        </section>

        <section className="card span-5">
          <div className="card__head"><div><h2>Where income went</h2><p className="t-small">Share of {fmt(now.income, { whole: true })}</p></div></div>
          {now.income > 0 ? (
            <SegmentedBar
              tall label="Income split"
              parts={[
                { key: 's', label: 'Spent', value: now.spent, color: 'var(--c1)' },
                { key: 'd', label: 'Debt', value: now.debt, color: 'var(--c2)' },
                { key: 'v', label: 'Saved', value: now.saved, color: 'var(--c3)' },
                { key: 'l', label: 'Left over', value: Math.max(0, now.left), color: 'var(--c6)' },
              ]}
            />
          ) : <p className="t-small">No income in this range.</p>}
          <dl className="sum">
            <div><dt>Average per day spent</dt><dd>{fmt(Math.round(now.spent / span), { whole: true })}</dd></div>
            <div><dt>Savings rate</dt><dd>{now.income > 0 ? `${Math.round((now.saved / now.income) * 100)}%` : '—'}</dd></div>
          </dl>
        </section>
      </div>
    </>
  );
}
