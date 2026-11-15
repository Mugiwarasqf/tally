import { useState } from 'react';
import { addDays, dow, fmtDay, fmtWeekday, monthShort, weekStart } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { Tip, useTip, useWidth } from './core';

const LABEL_W = 30;
const HEAD_H = 18;
const GAP = 3;
const RAMP = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-5)', 'var(--seq-7)'];

/**
 * Calendar heat map: one cell per day, columns are weeks (Monday first). One hue, light → dark,
 * stepped by quartile so a single huge day doesn't wash out the rest. Zero-spend days stay empty.
 */
export function Heatmap({ values, from, to, label }: { values: Map<ISODate, Pence>; from: ISODate; to: ISODate; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { tip, setTip, hide } = useTip();
  const [hover, setHover] = useState<ISODate | null>(null);

  const start = weekStart(from);
  const weeks: ISODate[] = [];
  for (let d = start; d <= to; d = addDays(d, 7)) weeks.push(d);
  const cell = Math.max(10, Math.min(22, Math.floor((w - LABEL_W) / Math.max(weeks.length, 1)) - GAP));
  const sorted = [...values.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75), q(0.92)];
  const shade = (v: number) => (v <= 0 ? null : RAMP[cuts.filter((c) => v > c).length]!);
  const height = HEAD_H + 7 * (cell + GAP);

  return (
    <div className="chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label}>
          {['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d, r) => d && (
            <text key={r} x={0} y={HEAD_H + r * (cell + GAP) + cell / 2} className="tick" dominantBaseline="middle">{d}</text>
          ))}
          {weeks.map((ws, c) => {
            const prev = c > 0 ? weeks[c - 1]! : null;
            const showMonth = !prev || ws.slice(5, 7) !== prev.slice(5, 7);
            return (
              <g key={ws}>
                {showMonth && <text x={LABEL_W + c * (cell + GAP)} y={11} className="tick">{monthShort(Number(ws.slice(5, 7)))}</text>}
                {Array.from({ length: 7 }, (_, r) => {
                  const d = addDays(ws, r);
                  if (d < from || d > to) return null;
                  const v = values.get(d) ?? 0;
                  const fill = shade(v);
                  const x = LABEL_W + c * (cell + GAP);
                  const y = HEAD_H + ((dow(d) + 6) % 7) * (cell + GAP);
                  return (
                    <rect
                      key={d} x={x} y={y} width={cell} height={cell} rx={4}
                      className={`hm-cell${hover === d ? ' is-hover' : ''}`} fill={fill ?? 'var(--surface-2)'}
                      tabIndex={0}
                      aria-label={`${fmtWeekday(d)} ${fmtDay(d)}: ${v > 0 ? fmt(v) : 'no spending'}`}
                      onPointerEnter={() => { setHover(d); setTip({ x: x + cell / 2, y: y + cell / 2, title: `${fmtWeekday(d)} ${fmtDay(d)}`, rows: [{ name: v > 0 ? 'spent' : 'no spending', value: v > 0 ? fmt(v) : fmt(0) }] }); }}
                      onPointerLeave={() => { setHover(null); hide(); }}
                      onFocus={() => { setHover(d); setTip({ x: x + cell / 2, y: y + cell / 2, title: `${fmtWeekday(d)} ${fmtDay(d)}`, rows: [{ name: 'spent', value: fmt(v) }] }); }}
                      onBlur={() => { setHover(null); hide(); }}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      <Tip tip={tip} boundsW={w} />
      <div className="scale" aria-hidden="true">
        <span className="t-xs">Less</span>
        {RAMP.map((c) => <i key={c} style={{ background: c }} />)}
        <span className="t-xs">More</span>
      </div>
    </div>
  );
}
