import { useState } from 'react';
import { fmt } from '../../lib/money';
import { axisMoney, niceScale, Tip, useSize, useTip } from './core';

export interface Series {
  name: string;
  color: string; // CSS colour or var()
}
export interface ColumnDatum {
  key: string;
  label: string; // axis label
  title?: string; // tooltip heading (defaults to label)
  values: number[]; // one per series, pence, >= 0
}

const PAD = { l: 48, r: 4, t: 10, b: 26 };
const MAX_BAR = 24; // marks stay slim — never fill the slot
const GAP = 2; // surface gap between touching bars

/** Path for a bar with a 4px rounded data-end and a square baseline. */
function bar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/**
 * Vertical columns, one group per period. Hover or focus a group for every series' value.
 * Optionally draws a horizontal reference line (e.g. the daily allowance).
 */
export function ColumnChart(props: {
  data: ColumnDatum[];
  series: Series[];
  height?: number;
  label: string; // accessible name
  reference?: { value: number; name: string };
  selectedKey?: string;
  /** Grow to fill the card's spare height instead of using a fixed one (`height` becomes the minimum). */
  fill?: boolean;
}) {
  const { data, series, label, selectedKey } = props;
  const minHeight = props.height ?? 240;
  const [wrapRef, w, boxH] = useSize<HTMLDivElement>();
  const height = props.fill ? Math.max(minHeight, boxH) : minHeight;
  const { tip, setTip, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(0, ...data.flatMap((d) => d.values), props.reference?.value ?? 0);
  const { top, ticks } = niceScale(max, 4);
  const compact = top >= 1_000_000;
  const innerW = Math.max(0, w - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(2, Math.min(MAX_BAR, (band * 0.78 - GAP * (series.length - 1)) / series.length));
  const groupW = barW * series.length + GAP * (series.length - 1);
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const step = Math.max(1, Math.ceil(56 / Math.max(band, 1)));

  const show = (i: number, el: SVGGElement | null) => {
    const d = data[i]!;
    const box = el?.getBoundingClientRect();
    const host = wrapRef.current?.getBoundingClientRect();
    if (!box || !host) return;
    setHover(i);
    setTip({
      x: box.left - host.left + box.width / 2,
      y: Math.min(Math.max(box.top - host.top + 24, 30), height - 40),
      title: d.title ?? d.label,
      rows: series.map((s, k) => ({ color: s.color, name: s.name, value: fmt(d.values[k] ?? 0) })),
    });
  };
  const leave = () => { setHover(null); hide(); };

  return (
    <div className={`chart${props.fill ? ' chart--fill' : ''}`} ref={wrapRef} style={props.fill ? { minHeight } : undefined}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-line' : 'grid-line'} />
              <text x={PAD.l - 10} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{axisMoney(t, compact)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.l + band * i + band / 2;
            const x0 = cx - groupW / 2;
            const dim = hover !== null && hover !== i;
            return (
              <g
                key={d.key} tabIndex={0} className={`col${dim ? ' is-dim' : ''}${selectedKey === d.key ? ' is-selected' : ''}`}
                onPointerEnter={(e) => show(i, e.currentTarget)} onPointerLeave={leave}
                onFocus={(e) => show(i, e.currentTarget)} onBlur={leave}
                aria-label={`${d.title ?? d.label}: ${series.map((s, k) => `${s.name} ${fmt(d.values[k] ?? 0)}`).join(', ')}`}
              >
                {/* Hit area spans the whole band — far larger than the bar itself. */}
                <rect x={PAD.l + band * i} y={PAD.t} width={band} height={innerH + PAD.b} fill="transparent" />
                {series.map((s, k) => {
                  const v = d.values[k] ?? 0;
                  const h = Math.max(v > 0 ? 2 : 0, (v / top) * innerH);
                  return <path key={s.name} d={bar(x0 + k * (barW + GAP), PAD.t + innerH - h, barW, h)} fill={s.color} />;
                })}
                {i % step === 0 && <text x={cx} y={height - 6} className="tick" textAnchor="middle">{d.label}</text>}
              </g>
            );
          })}
          {props.reference && props.reference.value > 0 && (
            <g className="refline" pointerEvents="none">
              <line x1={PAD.l} x2={w - PAD.r} y1={y(props.reference.value)} y2={y(props.reference.value)} />
              <text x={w - PAD.r} y={y(props.reference.value) - 6} textAnchor="end" className="tick tick--strong">{props.reference.name}</text>
            </g>
          )}
        </svg>
      )}
      <Tip tip={tip} boundsW={w} />
    </div>
  );
}
