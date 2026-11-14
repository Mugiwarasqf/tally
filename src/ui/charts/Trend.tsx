import { useState } from 'react';
import { fmt } from '../../lib/money';
import type { MonthPoint, Trend } from '../../domain/analytics/trend';
import { axisMoney, niceScale, Tip, useTip, useWidth } from './core';

const PAD = { l: 52, r: 12, t: 14, b: 28 };
const MAX_BAR = 28;

const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n) ? 0 : n % 10] ?? 'th'}`;

/**
 * Monthly spending against the history that came before each month.
 *   columns   – what you spent (the selected month in colour, the rest in grey)
 *   line      – "your usual": the average of the earlier complete months
 *   band      – the normal range: one standard deviation either side of usual
 *   dotted    – the straight-line trend through recent months
 * An unfinished month shows a lighter bar for its projected total, with the real amount so far inside it.
 */
export function TrendChart({ points, trend, selectedKey, label }: { points: MonthPoint[]; trend: Trend | null; selectedKey: string; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { tip, setTip, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const height = 300;

  const value = (p: MonthPoint) => (p.complete ? p.spent : (p.projected ?? p.spent));
  const hi = Math.max(1, ...points.map((p) => Math.max(value(p), p.baseline !== undefined && p.sigma !== undefined ? p.baseline + p.sigma : 0)));
  const { top, ticks } = niceScale(hi, 4);
  const innerW = Math.max(0, w - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const band = points.length ? innerW / points.length : 0;
  const barW = Math.max(6, Math.min(MAX_BAR, band * 0.6));
  const cx = (i: number) => PAD.l + band * i + band / 2;
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const step = Math.max(1, Math.ceil(52 / Math.max(band, 1)));

  // Baseline line and band, drawn over the months that have enough history behind them.
  const withBase = points.map((p, i) => ({ p, i })).filter(({ p }) => p.baseline !== undefined);
  const baseLine = withBase.map(({ p, i }, k) => `${k ? 'L' : 'M'}${cx(i).toFixed(1)},${y(p.baseline!).toFixed(1)}`).join('');
  const withBand = withBase.filter(({ p }) => p.sigma !== undefined);
  const bandPath = withBand.length > 1
    ? `${withBand.map(({ p, i }, k) => `${k ? 'L' : 'M'}${cx(i).toFixed(1)},${y(p.baseline! + p.sigma!).toFixed(1)}`).join('')}${[...withBand].reverse().map(({ p, i }) => `L${cx(i).toFixed(1)},${y(Math.max(0, p.baseline! - p.sigma!)).toFixed(1)}`).join('')}Z`
    : '';

  // Trend line through the recent complete months (same window trendOf uses).
  const done = points.map((p, i) => ({ p, i })).filter(({ p }) => p.complete).slice(-12);
  let trendPath = '';
  if (trend && done.length >= 3) {
    const m = done.reduce((s, { p }) => s + p.spent, 0) / done.length;
    const at = (j: number) => m + trend.perMonth * (j - (done.length - 1) / 2);
    trendPath = `M${cx(done[0]!.i).toFixed(1)},${y(Math.max(0, at(0))).toFixed(1)}L${cx(done.at(-1)!.i).toFixed(1)},${y(Math.max(0, at(done.length - 1))).toFixed(1)}`;
  }

  const show = (i: number, el: SVGGElement | null) => {
    const p = points[i]!;
    const host = ref.current?.getBoundingClientRect();
    const box = el?.getBoundingClientRect();
    if (!host || !box) return;
    setHover(i);
    const rows: Array<{ color?: string; name: string; value: string }> = [{ color: 'var(--c1)', name: p.complete ? 'Spent' : 'Spent so far', value: fmt(p.spent) }];
    if (!p.complete && p.projected !== undefined) rows.push({ color: 'var(--c-other)', name: 'Projected', value: fmt(p.projected) });
    if (p.baseline !== undefined) rows.push({ color: 'var(--ink-2)', name: 'Your usual', value: fmt(p.baseline) });
    if (p.deviation !== undefined) rows.push({ name: 'vs usual', value: `${p.deviation >= 0 ? '+' : '−'}${Math.round(Math.abs(p.deviation) * 100)}%` });
    if (p.rank !== undefined && p.of !== undefined && p.of >= 3) rows.push({ name: 'rank', value: p.rank === 1 ? `Highest of ${p.of}` : p.rank === p.of ? `Lowest of ${p.of}` : `${ordinal(p.rank)} highest of ${p.of}` });
    setTip({ x: box.left - host.left + box.width / 2, y: Math.min(Math.max(box.top - host.top + 28, 40), height - 60), title: p.label, rows });
  };
  const leave = () => { setHover(null); hide(); };

  return (
    <div className="chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-line' : 'grid-line'} />
              <text x={PAD.l - 10} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{axisMoney(t, top >= 1_000_000)}</text>
            </g>
          ))}
          {bandPath && <path d={bandPath} fill="var(--ink-3)" opacity={0.14} />}
          {points.map((p, i) => {
            const sel = p.key === selectedKey;
            const fill = sel ? 'var(--c1)' : 'var(--c-other)';
            const x = cx(i) - barW / 2;
            const hv = y(value(p));
            const hs = y(p.spent);
            return (
              <g
                key={p.key} tabIndex={0} className={`col${hover !== null && hover !== i ? ' is-dim' : ''}`}
                onPointerEnter={(e) => show(i, e.currentTarget)} onPointerLeave={leave} onFocus={(e) => show(i, e.currentTarget)} onBlur={leave}
                aria-label={`${p.label}: spent ${fmt(p.spent)}${p.baseline !== undefined ? `, usual ${fmt(p.baseline)}` : ''}`}
              >
                <rect x={PAD.l + band * i} y={PAD.t} width={band} height={innerH + PAD.b} fill="transparent" />
                {p.complete
                  ? <rect x={x} y={hv} width={barW} height={Math.max(2, PAD.t + innerH - hv)} rx={4} fill={fill} />
                  : (
                    <>
                      <rect x={x} y={hv} width={barW} height={Math.max(2, PAD.t + innerH - hv)} rx={4} fill={fill} opacity={0.35} />
                      <rect x={x} y={hs} width={barW} height={Math.max(2, PAD.t + innerH - hs)} rx={4} fill={fill} />
                    </>
                  )}
                {i % step === 0 && <text x={cx(i)} y={height - 8} className={`tick${sel ? ' tick--strong' : ''}`} textAnchor="middle">{p.label}</text>}
              </g>
            );
          })}
          {baseLine && (
            <g pointerEvents="none">
              <path d={baseLine} className="line" stroke="var(--ink-2)" />
              {withBase.map(({ p, i }) => <circle key={p.key} cx={cx(i)} cy={y(p.baseline!)} r={4} fill="var(--ink-2)" className="dot" />)}
            </g>
          )}
          {trendPath && <path d={trendPath} className="line line--proj" stroke="var(--ink)" pointerEvents="none" />}
        </svg>
      )}
      <Tip tip={tip} boundsW={w} />
    </div>
  );
}
