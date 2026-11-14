import type { ReactNode } from 'react';
import { fmt } from '../../lib/money';
import { useWidth } from './core';

export interface BarRow {
  key: string;
  label: string;
  value: number; // pence
  lead?: ReactNode; // e.g. a category tile
  sub?: string;
  /** Marker on the track, e.g. last month's value. */
  mark?: number;
  onClick?: () => void;
}

/**
 * Ranked horizontal bars: one hue, largest first, value at the tip. Bars on one baseline
 * compare far more exactly than segments laid end to end, which is why this is the default
 * for "where did it go".
 */
export function RankedBars({ rows, max, label }: { rows: BarRow[]; max?: number; label: string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value), ...rows.map((r) => r.mark ?? 0));
  return (
    <ul className="rbars" aria-label={label}>
      {rows.map((r) => {
        const Tag = r.onClick ? 'button' : 'div';
        return (
          <li key={r.key}>
            <Tag className="rbar" onClick={r.onClick} {...(r.onClick ? { type: 'button' as const } : {})}>
              {r.lead}
              <span className="rbar__main">
                <span className="rbar__line">
                  <span className="rbar__label">{r.label}</span>
                  <span className="rbar__value num">{fmt(r.value)}</span>
                </span>
                <span className="rbar__track" aria-hidden="true">
                  <i style={{ width: `${Math.max(1.5, (r.value / top) * 100)}%` }} />
                  {r.mark !== undefined && <b style={{ left: `${Math.min(100, (r.mark / top) * 100)}%` }} />}
                </span>
                {r.sub && <span className="rbar__sub">{r.sub}</span>}
              </span>
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  text?: string; // label colour inside the block
}

/**
 * One whole split into parts. Tall: each block prints its share if it fits, otherwise nothing
 * (the legend and tooltip carry it). Thin: no text, for rows that already list the figures.
 */
export function SegmentedBar({ parts, tall, label, showLegend = true }: { parts: Part[]; tall?: boolean; label: string; showLegend?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const live = parts.filter((p) => p.value > 0);
  return (
    <div ref={ref} className="segwrap">
      <div className={`segbar${tall ? ' segbar--tall' : ''}`} role="img" aria-label={`${label}: ${live.map((p) => `${p.label} ${fmt(p.value)}`).join(', ')}`}>
        {live.map((p) => {
          const share = total ? p.value / total : 0;
          const px = share * w;
          const text = `${Math.round(share * 100)}%`;
          return (
            <i key={p.key} style={{ width: `${share * 100}%`, background: p.color, color: p.text ?? 'var(--on-c)' }} title={`${p.label}: ${fmt(p.value)} (${text})`}>
              {tall && px >= text.length * 8 + 18 ? text : null}
            </i>
          );
        })}
      </div>
      {showLegend && (
        <div className="legend">
          {live.map((p) => (
            <span className="legend__item" key={p.key}><i className="legend__sw" style={{ background: p.color }} />{p.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}
