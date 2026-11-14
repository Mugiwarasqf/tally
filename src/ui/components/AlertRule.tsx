import { useApp } from '../../app/data';
import { saveSettings } from '../../data/settings';
import type { AlertRule } from '../../domain/types';
import type { PayState, Schedule } from '../../domain/analytics/schedule';
import { fmtDay } from '../../lib/dates';
import { fmt } from '../../lib/money';
import { Icon } from '../icons';
import { Banner, Switch } from './bits';
import { Sheet } from './overlay';

type MissedChoice = 'default' | 'off' | '1' | '2' | '3';

const toChoice = (r: AlertRule['missed']): MissedChoice => (r === undefined ? 'default' : r === 'off' ? 'off' : (String(r) as MissedChoice));
const fromChoice = (c: MissedChoice): AlertRule['missed'] => (c === 'default' ? undefined : c === 'off' ? 'off' : (Number(c) as 1 | 2 | 3));

/**
 * Per-payment alert settings: remind me before it's due, and tell me if it's missed — never,
 * straight away, or only after it has been missed several times in a row ("on multiple occasions").
 * Anything left on "default" follows the global choice in Settings.
 */
export function AlertRuleSheet({ itemKey, title, source, onClose }: { itemKey: string; title: string; source: 'recurring' | 'debt'; onClose: () => void }) {
  const { settings } = useApp();
  const n = settings.notifications;
  const rule = n.items[itemKey] ?? {};
  const def = source === 'debt' ? n.debtMissedAfter : n.missedAfter;

  const update = (patch: Partial<AlertRule>) => {
    const next: AlertRule = { ...rule, ...patch };
    const items = { ...n.items };
    if (next.upcoming === undefined && next.missed === undefined) delete items[itemKey];
    else items[itemKey] = next;
    return saveSettings({ notifications: { ...n, items } });
  };

  const label = (c: MissedChoice) =>
    c === 'default' ? `Use my default (${def === 1 ? 'first miss' : `after ${def} in a row`})`
    : c === 'off' ? 'Never'
    : c === '1' ? 'On the first miss'
    : `After ${c} missed in a row`;

  return (
    <Sheet title={`Alerts for ${title}`} onClose={onClose}>
      {!n.enabled && (
        <Banner tone="brand" icon="BellRinging">
          System notifications are off, so these alerts appear in the bell inside Tally. Turn notifications on from the bell menu to get them on your device.
        </Banner>
      )}
      <label className="split">
        <span>
          <span className="t-label" style={{ color: 'var(--ink)' }}>Remind me before it’s due</span>
          <span className="field__hint" style={{ display: 'block' }}>A heads-up about three days ahead.</span>
        </span>
        <Switch checked={rule.upcoming ?? true} label="Remind me before it's due" onChange={(v) => update({ upcoming: v ? undefined : false })} />
      </label>
      <hr className="divider" />
      <div className="field">
        <label htmlFor="missed-rule">If a payment is missed</label>
        <select id="missed-rule" className="select" value={toChoice(rule.missed)} onChange={(e) => update({ missed: fromChoice(e.target.value as MissedChoice) })}>
          {(['default', '1', '2', '3', 'off'] as MissedChoice[]).map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </select>
        <span className="field__hint">
          Choosing “after 2” or “after 3” keeps one-off hiccups quiet and only alerts you when it keeps happening.
          It also warns you when a payment keeps arriving late. Misses are only judged for dates your statements cover.
        </span>
      </div>
    </Sheet>
  );
}

// ---- payment history strip ---------------------------------------------------------------------------------
const STATE: Record<PayState, { icon: string; label: string; cls: string }> = {
  paid: { icon: 'CheckCircle', label: 'Paid', cls: 'ph--paid' },
  late: { icon: 'Clock', label: 'Paid late', cls: 'ph--late' },
  partial: { icon: 'Warning', label: 'Part-paid', cls: 'ph--partial' },
  missed: { icon: 'WarningCircle', label: 'Missed', cls: 'ph--missed' },
  pending: { icon: 'DotsThree', label: 'Not yet judged', cls: 'ph--pending' },
};

/** The last six due dates as icon + month, so status never relies on colour alone. */
export function PayHistory({ s }: { s: Schedule }) {
  return (
    <ol className="ph" aria-label={`Payment history for ${s.label}`}>
      {s.history.map((o) => {
        const st = STATE[o.state];
        const month = new Date(o.due).toLocaleString('en-GB', { month: 'short' });
        const text = `${fmtDay(o.due)}: ${st.label}${o.paid !== undefined && o.state === 'partial' ? ` (${fmt(o.paid)} of ${fmt(s.expected)})` : ''}`;
        return (
          <li key={o.due} className={`ph__item ${st.cls}`} title={text} aria-label={text}>
            <Icon name={st.icon} size={18} weight="fill" />
            <span>{month}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** One plain-English line about how a schedule is doing. */
export function scheduleSummary(s: Schedule): string {
  if (s.missedInRow >= 2) return `${s.missedInRow} payments missed in a row, since ${fmtDay(s.firstMissed!)}`;
  if (s.missedInRow === 1) return `Payment due ${fmtDay(s.firstMissed!)} hasn’t appeared`;
  if (s.lateCount >= 2) return `Paid late ${s.lateCount} of the last ${s.history.length} times`;
  if (s.status === 'late') return 'Last payment arrived late';
  if (s.status === 'pending') return 'Waiting on the latest due date';
  return 'Paid on time';
}
