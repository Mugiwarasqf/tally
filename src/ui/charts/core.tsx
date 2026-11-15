import { useCallback, useEffect, useRef, useState } from 'react';
import { sym } from '../../lib/money';
import type { ReactNode, RefObject } from 'react';
import { Icon } from '../icons';

/** Width of an element, kept in sync as it resizes. Charts draw to this width so nothing is ever scaled or clipped. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Like useWidth, plus the element's height — for charts that should fill whatever room their card gives them. */
export function useSize<T extends HTMLElement>(): [RefObject<T | null>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e!.contentRect.width), h: Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h];
}

/** "Nice" axis: round step sizes (1, 2, 2.5, 5 × 10ⁿ) so ticks read as clean numbers. */
export function niceScale(max: number, target = 4): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

/** Axis money: full figures below 10,000, compact above — one style per axis. */
export function axisMoney(p: number, compact: boolean): string {
  const v = p / 100;
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  const s = sym();
  if (compact) return `${sign}${s}${a >= 1e9 ? `${+(a / 1e9).toFixed(1)}bn` : a >= 1e6 ? `${+(a / 1e6).toFixed(1)}m` : `${+(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`}`;
  return `${sign}${s}${Math.round(a).toLocaleString('en-GB')}`;
}

// ---- tooltip -----------------------------------------------------------------------------
export interface TipState {
  x: number;
  y: number;
  title: string;
  rows: Array<{ color?: string; name: string; value: string }>;
}

export function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const hide = useCallback(() => setTip(null), []);
  return { tip, setTip, hide };
}

/** One tooltip for every series at the hovered position. Values lead; names follow. Text only — never HTML. */
export function Tip({ tip, boundsW }: { tip: TipState | null; boundsW: number }) {
  if (!tip) return null;
  const flip = tip.x > boundsW * 0.62;
  return (
    <div className="tip" role="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, -50%)` }}>
      <div className="tip__title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div className="tip__row" key={i}>
          {r.color && <i className="tip__key" style={{ background: r.color }} />}
          <span className="tip__val">{r.value}</span>
          <span className="tip__name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

// ---- legend ---------------------------------------------------------------------------------
export function Legend({ items }: { items: Array<{ name: string; color: string }> }) {
  return (
    <div className="legend" aria-label="Legend">
      {items.map((i) => (
        <span className="legend__item" key={i.name}>
          <i className="legend__sw" style={{ background: i.color }} />
          {i.name}
        </span>
      ))}
    </div>
  );
}

// ---- table twin ---------------------------------------------------------------------------------
export function ChartTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="tablewrap chart-table">
      <table className="table">
        <thead>
          <tr>{head.map((h, i) => <th key={h} className={i ? 'r' : ''}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'r' : ''}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Title, optional filters/legend, the chart, and a table view of the same data (the accessible twin). */
export function ChartCard(props: {
  title: string;
  sub?: ReactNode;
  legend?: ReactNode;
  controls?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section className={`card chart-card ${props.className ?? ''}`}>
      <div className="card__head">
        <div>
          <h2>{props.title}</h2>
          {props.sub && <p className="t-small">{props.sub}</p>}
        </div>
        {props.controls}
        {props.table && (
          <button
            className="icon-btn" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
            aria-label={view === 'chart' ? 'Show as table' : 'Show as chart'} aria-pressed={view === 'table'} title={view === 'chart' ? 'Table view' : 'Chart view'}
          >
            <Icon name={view === 'chart' ? 'Table' : 'ChartBar'} size={20} />
          </button>
        )}
      </div>
      {props.legend}
      {view === 'chart' ? props.children : props.table}
    </section>
  );
}
