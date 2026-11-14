import { useState } from 'react';
import { fmt } from '../../lib/money';
import type { WaterfallStep } from '../../domain/analytics/report';
import { axisMoney, niceScale, Tip, useSize, useTip } from './core';

const PAD = { l: 52, r: 8, t: 22, b: 54 };
const MAX_BAR = 40;

/**
 * Variance waterfall: starts at the plan, each category's swing floats up (over plan) or down (under plan),
 * and it lands on what was actually spent. The same reconciliation finance teams use to explain "why is it
 * different from the budget?". Direction is shown three ways: position, the sign in the label, and colour.
 */
export function Waterfall({ steps, label, fill }: { steps: WaterfallStep[]; label: string; /** Grow to fill the card's spare height. */ fill?: boolean }) {
  const [ref, w, boxH] = useSize<HTMLDivElement>();
  const { tip, setTip, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const minHeight = 300;
  const height = fill ? Math.max(minHeight, boxH) : minHeight;

  // Running total: where each floating bar starts and ends.
  let run = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') { run = s.value; return { s, from: 0, to: s.value }; }
    const from = run;
    run += s.value;
    return { s, from, to: run };
  });
  const hi = Math.max(1, ...bars.flatMap((b) => [b.from, b.to]));
  const { top, ticks } = niceScale(hi, 4);
  const innerW = Math.max(0, w - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const band = bars.length ? innerW / bars.length : 0;
  const barW = Math.max(10, Math.min(MAX_BAR, band * 0.62));
  const cx = (i: number) => PAD.l + band * i + band / 2;
  const y = (v: number) => PAD.t + innerH - (Math.max(0, v) / top) * innerH;
  const clip = (s: string) => (s.length > Math.max(6, Math.floor(band / 6.5)) ? `${s.slice(0, Math.max(5, Math.floor(band / 6.5) - 1))}…` : s);

  const show = (i: number, el: SVGGElement | null) => {
    const host = ref.current?.getBoundingClientRect();
    const box = el?.getBoundingClientRect();
    const b = bars[i]!;
    if (!host || !box) return;
    setHover(i);
    setTip({
      x: box.left - host.left + box.width / 2, y: Math.min(Math.max(box.top - host.top + 30, 40), height - 70), title: b.s.label,
      rows: b.s.kind === 'total'
        ? [{ name: b.s.label === 'Plan' ? 'planned' : 'actually spent', value: fmt(b.s.value) }]
        : [{ name: b.s.value > 0 ? 'over plan' : 'under plan', value: fmt(b.s.value, { sign: true }) }, { name: 'running total', value: fmt(b.to) }],
    });
  };
  const leave = () => { setHover(null); hide(); };

  return (
    <div className={`chart${fill ? ' chart--fill' : ''}`} ref={ref} style={fill ? { minHeight } : undefined}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-line' : 'grid-line'} />
              <text x={PAD.l - 10} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{axisMoney(t, top >= 1_000_000)}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const total = b.s.kind === 'total';
            const up = b.s.value > 0;
            const y0 = y(Math.max(b.from, b.to));
            const y1 = y(Math.min(b.from, b.to));
            const fill = total ? (b.s.label === 'Plan' ? 'var(--ink-3)' : 'var(--c1)') : up ? 'var(--div-up)' : 'var(--div-down)';
            const next = bars[i + 1];
            return (
              <g
                key={i} tabIndex={0} className={`col${hover !== null && hover !== i ? ' is-dim' : ''}`}
                onPointerEnter={(e) => show(i, e.currentTarget)} onPointerLeave={leave} onFocus={(e) => show(i, e.currentTarget)} onBlur={leave}
                aria-label={`${b.s.label}: ${total ? fmt(b.s.value) : fmt(b.s.value, { sign: true })}`}
              >
                <rect x={PAD.l + band * i} y={PAD.t} width={band} height={innerH + PAD.b} fill="transparent" />
                {next && <line x1={cx(i) + barW / 2} x2={cx(i + 1) - barW / 2} y1={y(b.to)} y2={y(b.to)} className="grid-line" pointerEvents="none" />}
                <rect x={cx(i) - barW / 2} y={y0} width={barW} height={Math.max(2, y1 - y0)} rx={3} fill={fill} />
                <text x={cx(i)} y={y0 - 6} textAnchor="middle" className="tick tick--strong">
                  {total ? fmt(b.s.value, { whole: true }) : `${up ? '+' : '−'}${fmt(Math.abs(b.s.value), { whole: true })}`}
                </text>
                <text x={cx(i)} y={height - PAD.b + 16} textAnchor="middle" className="tick">{clip(b.s.label)}</text>
              </g>
            );
          })}
        </svg>
      )}
      <Tip tip={tip} boundsW={w} />
    </div>
  );
}
