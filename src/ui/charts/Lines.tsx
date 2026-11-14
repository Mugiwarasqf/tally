import { useState } from 'react';
import { fmt } from '../../lib/money';
import { axisMoney, niceScale, Tip, useTip, useWidth } from './core';

export interface LineSeries {
  name: string;
  color: string;
  values: Array<number | null>; // aligned with `labels`
  /** Index from which the line is a projection and drawn lighter. */
  projectedFrom?: number;
  area?: boolean;
}

const PAD = { l: 52, r: 16, t: 14, b: 26 };

/**
 * Line chart with a crosshair that snaps to the nearest x and one tooltip listing every series.
 * 2px lines, ≥8px end markers with a 2px surface ring, 10% area wash for a single series.
 */
export function LineChart(props: {
  labels: string[];
  titles?: string[];
  series: LineSeries[];
  height?: number;
  label: string;
  reference?: { value: number; name: string };
  /** Label the final value of the first series directly (the endpoint is the story). */
  endLabel?: boolean;
}) {
  const { labels, series } = props;
  const height = props.height ?? 240;
  const [wrapRef, w] = useWidth<HTMLDivElement>();
  const { tip, setTip, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);

  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...all);
  const hi = Math.max(1, ...all, props.reference?.value ?? 0);
  const { top, ticks } = niceScale(hi - Math.min(0, lo), 4);
  const base = Math.min(0, lo === 0 ? 0 : Math.floor(lo / (ticks[1] ?? 1)) * (ticks[1] ?? 1));
  const span = top || 1;
  const innerW = Math.max(0, w - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - ((v - base) / span) * innerH;
  const compact = top >= 1_000_000;
  const step = Math.max(1, Math.ceil(64 / Math.max(innerW / Math.max(n - 1, 1), 1)));

  const pathFor = (s: LineSeries, from: number, to: number) => {
    let d = '';
    let pen = false;
    for (let i = from; i <= to; i++) {
      const v = s.values[i];
      if (v === null || v === undefined) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.max(0, Math.min(n - 1, Math.round((px / Math.max(box.width, 1)) * (n - 1))));
    setHover(i);
    const vals = series.map((s) => s.values[i]).filter((v): v is number => v !== null && v !== undefined);
    setTip({
      x: x(i),
      y: vals.length ? y(Math.max(...vals)) : PAD.t + 20,
      title: props.titles?.[i] ?? labels[i]!,
      rows: series.filter((s) => s.values[i] !== null && s.values[i] !== undefined).map((s) => ({ color: s.color, name: s.name, value: fmt(s.values[i]!) })),
    });
  };
  const leave = () => { setHover(null); hide(); };

  return (
    <div className="chart" ref={wrapRef}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={props.label}>
          {ticks.map((t) => {
            const v = base + t;
            return (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis-line' : 'grid-line'} />
                <text x={PAD.l - 10} y={y(v)} className="tick" textAnchor="end" dominantBaseline="middle">{axisMoney(v, compact)}</text>
              </g>
            );
          })}
          {labels.map((l, i) => i % step === 0 && <text key={i} x={x(i)} y={height - 6} className="tick" textAnchor="middle">{l}</text>)}

          {props.reference && (
            <g className="refline" pointerEvents="none">
              <line x1={PAD.l} x2={w - PAD.r} y1={y(props.reference.value)} y2={y(props.reference.value)} />
              <text x={w - PAD.r} y={y(props.reference.value) - 6} textAnchor="end" className="tick tick--strong">{props.reference.name}</text>
            </g>
          )}

          {series.map((s) => {
            const lastReal = (() => { for (let i = n - 1; i >= 0; i--) if (s.values[i] !== null && s.values[i] !== undefined) return i; return -1; })();
            const cut = s.projectedFrom ?? n;
            const first = s.values.findIndex((v) => v !== null && v !== undefined);
            return (
              <g key={s.name}>
                {s.area && first >= 0 && lastReal >= 0 && (
                  <path d={`${pathFor(s, first, Math.min(cut, lastReal + 1) - 1)} L${x(Math.min(cut, lastReal + 1) - 1)},${y(base)} L${x(first)},${y(base)} Z`} fill={s.color} opacity={0.1} />
                )}
                <path d={pathFor(s, 0, Math.min(cut, n) - 1 + (cut < n ? 1 : 0))} className="line" stroke={s.color} />
                {cut < n && <path d={pathFor(s, Math.max(cut - 1, 0), n - 1)} className="line line--proj" stroke={s.color} />}
                {lastReal >= 0 && (
                  <circle cx={x(lastReal)} cy={y(s.values[lastReal]!)} r={5} fill={s.color} className="dot" />
                )}
              </g>
            );
          })}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + innerH} className="crosshair" />
              {series.map((s) => s.values[hover] !== null && s.values[hover] !== undefined && (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={5} fill={s.color} className="dot" />
              ))}
            </g>
          )}
          {props.endLabel && series[0] && (() => {
            const last = series[0].values.reduce<number>((a, v, i) => (v !== null && v !== undefined ? i : a), -1);
            if (last < 0 || hover !== null) return null;
            const anchor = x(last) > w - 70 ? 'end' : 'middle';
            return <text x={x(last)} y={y(series[0].values[last]!) - 12} textAnchor={anchor} className="tick tick--strong tick--value">{fmt(series[0].values[last]!, { whole: true })}</text>;
          })()}

          {/* Pointer layer covers the whole plot so the reader only has to aim at a date, not at a 2px line. */}
          <rect x={PAD.l} y={PAD.t} width={innerW} height={innerH} fill="transparent" tabIndex={0}
            onPointerMove={onMove} onPointerLeave={leave} onBlur={leave}
            onKeyDown={(e) => {
              const cur = hover ?? n - 1;
              const next = e.key === 'ArrowLeft' ? Math.max(0, cur - 1) : e.key === 'ArrowRight' ? Math.min(n - 1, cur + 1) : cur;
              if (next !== cur || hover === null) {
                setHover(next);
                setTip({ x: x(next), y: PAD.t + 20, title: props.titles?.[next] ?? labels[next]!, rows: series.filter((s) => s.values[next] != null).map((s) => ({ color: s.color, name: s.name, value: fmt(s.values[next]!) })) });
              }
            }}
            aria-label={`${props.label}. Use left and right arrow keys to read values.`}
          />
        </svg>
      )}
      <Tip tip={tip} boundsW={w} />
    </div>
  );
}
