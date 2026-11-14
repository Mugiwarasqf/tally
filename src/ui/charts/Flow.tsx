import { useState } from 'react';
import { fmt } from '../../lib/money';
import type { FlowSink, FlowSource, SinkKind } from '../../domain/analytics/flow';
import { Tip, useTip, useWidth } from './core';

/** One colour per destination, used everywhere income is split (flow diagram, segmented bars). */
export const SINK_COLOR: Record<SinkKind, string> = {
  needs: 'var(--c1)',
  wants: 'var(--c2)',
  debt: 'var(--c7)',
  saved: 'var(--c3)',
  left: 'var(--c6)',
};

const NODE_W = 10;
const GAP = 12;
const PAD_Y = 8;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

interface Placed { key: string; label: string; value: number; y: number; h: number; off: number }

/**
 * Income flow ("stem"): sources on the left, destinations on the right, and a ribbon for each route.
 * Every source feeds every destination in proportion to its share of income.
 */
export function FlowChart({ sources, sinks, label }: { sources: FlowSource[]; sinks: FlowSink[]; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { tip, setTip, hide } = useTip();
  const [hover, setHover] = useState<{ from?: string; to?: string } | null>(null);

  const compact = w < 520;
  const labelL = compact ? 96 : 150;
  const labelR = compact ? 112 : 150;
  const H = compact ? 280 : 300;
  const total = sources.reduce((s, x) => s + x.value, 0) || 1;
  const usable = H - PAD_Y * 2;
  const gaps = Math.max(sources.length, sinks.length) - 1;
  const scale = (usable - gaps * GAP) / total;

  const place = <T extends { key: string; label: string; value: number }>(items: T[]): Placed[] => {
    const hs = items.map((i) => Math.max(6, i.value * scale));
    const colH = hs.reduce((s, h) => s + h, 0) + (items.length - 1) * GAP;
    let y = PAD_Y + Math.max(0, (usable - colH) / 2);
    return items.map((it, i) => {
      const p = { key: it.key, label: it.label, value: it.value, y, h: hs[i]!, off: 0 };
      y += hs[i]! + GAP;
      return p;
    });
  };
  const L = place(sources);
  const R = place(sinks);

  const x0 = labelL + NODE_W;
  const x1 = w - labelR;
  const xm = (x0 + x1) / 2;

  // Ribbons: for each destination, take a slice from every source in proportion to the source's share.
  const ribbons = R.flatMap((sink) =>
    L.map((src) => {
      const v = (sink.value * src.value) / total;
      const th = v * scale;
      const sy = src.y + src.off;
      const ty = sink.y + sink.off;
      src.off += th;
      sink.off += th;
      const d = `M${x0},${sy} C${xm},${sy} ${xm},${ty} ${x1},${ty} L${x1},${ty + th} C${xm},${ty + th} ${xm},${sy + th} ${x0},${sy + th} Z`;
      return { d, from: src, to: sink, v, th };
    }),
  );

  const show = (r: (typeof ribbons)[number], e: React.PointerEvent | React.FocusEvent) => {
    const host = ref.current?.getBoundingClientRect();
    const pt = 'clientX' in e ? { x: e.clientX, y: e.clientY } : { x: (host?.left ?? 0) + xm, y: (host?.top ?? 0) + r.to.y };
    setHover({ from: r.from.key, to: r.to.key });
    setTip({
      x: pt.x - (host?.left ?? 0), y: pt.y - (host?.top ?? 0),
      title: `${r.from.label} → ${r.to.label}`,
      rows: [{ name: `${Math.round((r.v / Math.max(1, r.to.value)) * 100)}% of ${r.to.label.toLowerCase()}`, value: fmt(r.v) }],
    });
  };
  const off = () => { setHover(null); hide(); };
  const active = (r: (typeof ribbons)[number]) => !hover || hover.from === r.from.key || hover.to === r.to.key;
  const maxName = (lab: number) => Math.floor((lab - 14) / 6.4);

  return (
    <div className="chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label}>
          {ribbons.map((r, i) => (
            <path
              key={i} d={r.d} className="flow__ribbon" fill={SINK_COLOR[r.to.key as SinkKind]} opacity={active(r) ? (hover ? 0.55 : 0.3) : 0.08}
              tabIndex={0} aria-label={`${r.from.label} to ${r.to.label}: ${fmt(r.v)}`}
              onPointerMove={(e) => show(r, e)} onPointerLeave={off} onFocus={(e) => show(r, e)} onBlur={off}
            />
          ))}
          {L.map((n) => (
            <g key={n.key}>
              <rect x={labelL} y={n.y} width={NODE_W} height={n.h} rx={3} className="flow__source" />
              <text x={labelL - 8} y={n.y + n.h / 2 - (n.h >= 30 ? 7 : 0)} textAnchor="end" dominantBaseline="middle" className="flow__name">{clip(n.label, maxName(labelL))}</text>
              {n.h >= 30 && <text x={labelL - 8} y={n.y + n.h / 2 + 9} textAnchor="end" dominantBaseline="middle" className="tick tick--strong">{fmt(n.value, { whole: true })}</text>}
            </g>
          ))}
          {R.map((n) => (
            <g key={n.key}>
              <rect x={x1} y={n.y} width={NODE_W} height={n.h} rx={3} fill={SINK_COLOR[n.key as SinkKind]} />
              {n.h >= 30 ? (
                <>
                  <text x={x1 + NODE_W + 8} y={n.y + n.h / 2 - 7} dominantBaseline="middle" className="flow__name">{clip(n.label, maxName(labelR))}</text>
                  <text x={x1 + NODE_W + 8} y={n.y + n.h / 2 + 9} dominantBaseline="middle" className="tick tick--strong">{fmt(n.value, { whole: true })} · {Math.round((n.value / total) * 100)}%</text>
                </>
              ) : (
                <text x={x1 + NODE_W + 8} y={n.y + n.h / 2} dominantBaseline="middle" className="flow__name">{clip(n.label, maxName(labelR) - 6)} <tspan className="tick tick--strong">{fmt(n.value, { whole: true })}</tspan></text>
              )}
            </g>
          ))}
        </svg>
      )}
      <Tip tip={tip} boundsW={w} />
    </div>
  );
}
