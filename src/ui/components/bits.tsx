import type { CSSProperties, ReactNode } from 'react';
import { fmt } from '../../lib/money';
import type { Category } from '../../domain/types';
import type { Status } from '../../domain/analytics/budget';
import { Icon } from '../icons';

/** The CSS colour for a category's chart slot, or neutral grey. */
export const slotColor = (slot: number | null | undefined): string => (slot === null || slot === undefined ? 'var(--c-other)' : `var(--c${slot + 1})`);

/** Category identity: a tinted tile with its icon. Colour is a hint; the icon and the name carry identity. */
export function CatTile({ cat, size }: { cat: Category | undefined; size?: 'sm' | 'lg' }) {
  const cls = `tile${size ? ` tile--${size}` : ''}`;
  return (
    <span className={cls} style={{ '--tile': slotColor(cat?.slot) } as CSSProperties}>
      <Icon name={cat?.icon ?? 'Question'} size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />
    </span>
  );
}

export function IconTile({ name, tone, size }: { name: string; tone?: 'ink' | 'brand'; size?: 'sm' | 'lg' }) {
  return (
    <span className={`tile${tone ? ` tile--${tone}` : ''}${size ? ` tile--${size}` : ''}`}>
      <Icon name={name} size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />
    </span>
  );
}

/** Money with the pence set smaller — used for hero and stat figures. */
export function Money({ pence, whole, sign, className }: { pence: number; whole?: boolean; sign?: boolean; className?: string }) {
  return <span className={className}>{fmt(pence, { whole, sign })}</span>;
}

export function HeroMoney({ pence }: { pence: number }) {
  const neg = pence < 0;
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100).toLocaleString('en-GB');
  const p = String(abs % 100).padStart(2, '0');
  return (
    <span className="hero__figure t-hero" aria-label={fmt(pence)}>
      <span aria-hidden="true">{neg ? '−' : ''}£{pounds}<small>.{p}</small></span>
    </span>
  );
}

const STATUS: Record<Status, { label: string; icon: string; chip: string }> = {
  under: { label: 'Under pace', icon: 'TrendDown', chip: 'chip--brand' },
  ontrack: { label: 'On track', icon: 'CheckCircle', chip: 'chip--good' },
  watch: { label: 'Ahead of pace', icon: 'Warning', chip: 'chip--warn' },
  over: { label: 'Well ahead of pace', icon: 'WarningCircle', chip: 'chip--critical' },
};

/** Budget status always pairs colour with an icon and a label, never colour alone. */
export function StatusChip({ status, label, onHero }: { status: Status; label?: string; onHero?: boolean }) {
  const s = STATUS[status];
  return (
    <span className={`chip ${onHero ? 'chip--on-hero' : s.chip}`}>
      <Icon name={s.icon} size={14} weight="fill" />
      {label ?? s.label}
    </span>
  );
}

export const meterClass = (s: Status): string => `meter meter--${s}`;

export function Meter({ pct, status, thick, onHero, label }: { pct: number; status?: Status; thick?: boolean; onHero?: boolean; label: string }) {
  const w = Math.max(0, Math.min(1, pct)) * 100;
  return (
    <div
      className={`${onHero ? 'meter meter--on-hero' : status ? meterClass(status) : 'meter'}${thick ? ' meter--thick' : ''}`}
      role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)}
    >
      <i style={{ width: `${w}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty__art"><Icon name={icon} size={36} /></span>
      <h3 className="t-h2">{title}</h3>
      {children && <p className="t-small">{children}</p>}
      {action}
    </div>
  );
}

export function Banner({ tone, icon, children, action }: { tone?: 'warn' | 'critical' | 'good' | 'brand'; icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner${tone ? ` banner--${tone}` : ''}`}>
      <Icon name={icon ?? (tone === 'warn' || tone === 'critical' ? 'Warning' : 'Info')} size={20} />
      <div className="banner__body">{children}</div>
      {action && <div className="banner__action">{action}</div>}
    </div>
  );
}

export function CardHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card__head">
      <div>
        <h2>{title}</h2>
        {sub && <p className="t-small">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, wrap }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; /** Wrap onto a second line instead of scrolling (for narrow cards). */ wrap?: boolean }) {
  return (
    <div className={`seg${wrap ? ' seg--wrap' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Money input in pounds; reports pence. */
export function MoneyInput({ value, onChange, id, placeholder }: { value: number; onChange: (pence: number) => void; id?: string; placeholder?: string }) {
  return (
    <span className="input-wrap">
      <span className="input-wrap__prefix">£</span>
      <input
        id={id} className="input input--money" inputMode="decimal" placeholder={placeholder ?? '0.00'}
        defaultValue={value ? (value / 100).toFixed(2).replace(/\.00$/, '') : ''}
        key={value}
        onBlur={(e) => {
          const n = parseFloat(e.target.value.replace(/[^0-9.]/g, ''));
          onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </span>
  );
}
