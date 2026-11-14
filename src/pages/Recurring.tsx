import { useMemo, useState } from 'react';
import { useApp } from '../app/data';
import { saveSettings } from '../data/settings';
import { likelyRecurring, perMonth } from '../domain/analytics/recurring';
import type { LikelyRecurring } from '../domain/analytics/recurring';
import type { Recurring as RecurringPayment } from '../domain/analytics/recurring';
import type { Schedule } from '../domain/analytics/schedule';
import { fmtDay, fmtRelative } from '../lib/dates';
import { fmt } from '../lib/money';
import { AlertRuleSheet, PayHistory, scheduleSummary } from '../ui/components/AlertRule';
import { Banner, CardHead, CatTile, Empty } from '../ui/components/bits';
import { PinRecurringSheet, unpinRecurring } from '../ui/components/PinRecurring';
import { Icon } from '../ui/icons';

const CADENCE: Record<RecurringPayment['cadence'], string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', yearly: 'Yearly' };

function StatusChip({ s }: { s: Schedule | undefined }) {
  if (!s) return null;
  if (s.missedInRow > 0) return <span className="chip chip--critical"><Icon name="WarningCircle" size={14} weight="fill" />{s.missedInRow > 1 ? `${s.missedInRow} missed` : 'Missed'}</span>;
  if (s.lateCount >= 2 || s.status === 'late') return <span className="chip chip--warn"><Icon name="Clock" size={14} weight="fill" />{s.lateCount >= 2 ? 'Often late' : 'Paid late'}</span>;
  if (s.status === 'pending') return <span className="chip"><Icon name="DotsThree" size={14} weight="bold" />Waiting</span>;
  return <span className="chip chip--good"><Icon name="CheckCircle" size={14} weight="fill" />On time</span>;
}

export function Recurring() {
  const { recurring, schedules, catMap, settings, today, txns } = useApp();
  const [tab, setTab] = useState<'out' | 'in'>('out');
  const [rule, setRule] = useState<{ key: string; title: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ mkey?: string; cadence?: LikelyRecurring['cadence'] } | null>(null);
  const likely = useMemo(() => likelyRecurring(txns, catMap, recurring, settings.dismissedRecurring), [txns, catMap, recurring, settings.dismissedRecurring]);

  const list = useMemo(() => recurring.filter((r) => r.direction === tab), [recurring, tab]);
  const outgoing = recurring.filter((r) => r.direction === 'out');
  const monthly = outgoing.reduce((s, r) => s + perMonth(r), 0);
  const annual = outgoing.reduce((s, r) => s + r.annual, 0);
  const byKey = useMemo(() => new Map(schedules.map((s) => [s.key, s])), [schedules]);
  const attention = schedules.filter((s) => s.source === 'recurring' && (s.missedInRow > 0 || s.lateCount >= 2));
  const hidden = settings.dismissedRecurring.length;

  if (!txns.length) {
    return <section className="card"><Empty icon="ArrowsClockwise" title="Nothing to detect yet">Import a few months of statements and Tally will pick out subscriptions, bills and salary by their rhythm.</Empty></section>;
  }

  return (
    <>
      <div className="bento">
        <section className="card span-5">
          <CardHead title="What repeats" sub="Detected from how often and how regularly payments recur" />
          <div className="stats">
            <div className="stat"><span className="stat__label">Per month</span><span className="stat__value">{fmt(monthly, { whole: true })}</span></div>
            <div className="stat"><span className="stat__label">Per year</span><span className="stat__value">{fmt(annual, { whole: true })}</span></div>
            <div className="stat"><span className="stat__label">Payments</span><span className="stat__value">{outgoing.length}</span></div>
            <div className="stat"><span className="stat__label">Need attention</span><span className="stat__value">{attention.length}</span></div>
          </div>
        </section>

        <section className="card span-7">
          <CardHead title="Missed and late" sub="Only judged for dates your statements cover" />
          {attention.length === 0 ? (
            <Banner tone="good" icon="CheckCircle">Every repeating payment Tally can see is arriving on time.</Banner>
          ) : (
            <div className="list">
              {attention.map((s) => (
                <div className="row" key={s.key}>
                  <span className={`tile ${s.missedInRow ? 'tile--missed' : 'tile--late'}`}><Icon name={s.missedInRow ? 'WarningCircle' : 'Clock'} size={20} weight="fill" /></span>
                  <span className="row__main"><span className="row__title">{s.label}</span><span className="row__sub">{scheduleSummary(s)}</span></span>
                  <button className="icon-btn" onClick={() => setRule({ key: s.key, title: s.label })} aria-label={`Alert settings for ${s.label}`}><Icon name="BellRinging" size={20} /></button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="page__head">
        <div className="tabs" role="tablist" aria-label="Direction">
          <button role="tab" aria-selected={tab === 'out'} onClick={() => setTab('out')}>Bills and subscriptions</button>
          <button role="tab" aria-selected={tab === 'in'} onClick={() => setTab('in')}>Income</button>
        </div>
        <span className="spacer" />
        {tab === 'out' && <button className="btn btn--secondary btn--sm" onClick={() => setAdding({})}><Icon name="Plus" size={16} weight="bold" />Add a bill</button>}
      </div>

      {tab === 'out' && likely.length > 0 && (
        <section className="card">
          <CardHead title="Likely recurring" sub="These look like bills but haven’t repeated enough to be sure. Add the ones that are." />
          <div className="list">
            {likely.map((l) => (
              <div key={l.key} className="review">
                <CatTile cat={catMap.get(l.categoryId)} />
                <div className="review__main">
                  <span className="row__title">{l.merchant} <span className="muted">· {fmt(l.amount)}</span></span>
                  <span className="row__sub" style={{ whiteSpace: 'normal' }}>{l.reasons.join(' · ')} · last {fmtDay(l.lastDate)}</span>
                </div>
                <div className="review__actions">
                  <button className="btn btn--primary btn--sm" onClick={() => setAdding({ mkey: l.mkey, cadence: l.cadence })}><Icon name="Plus" size={16} weight="bold" />Add</button>
                  <button className="btn btn--ghost btn--sm" onClick={() => saveSettings({ dismissedRecurring: [...settings.dismissedRecurring, l.key] })}>Not a bill</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {tab === 'out' && (
        <p className="t-small">Tally spots a bill on its own once it has repeated three times on a steady rhythm. Anything else: add it from <strong>Likely recurring</strong> or <strong>Add a bill</strong>.</p>
      )}

      {list.length === 0 ? (
        <section className="card"><Empty icon="ArrowsClockwise" title={tab === 'out' ? 'No repeating bills found' : 'No repeating income found'}>A payment needs to repeat at least three times at a steady rhythm before Tally treats it as recurring{tab === 'out' ? ', or you can add one yourself' : ''}.</Empty></section>
      ) : (
        <section className="stack">
          {list.map((r) => {
            const s = byKey.get(r.key);
            const days = Math.round((new Date(r.nextDate).getTime() - new Date(today).getTime()) / 86_400_000);
            const alertsOn = (settings.notifications.items[r.key]?.missed ?? 'default') !== 'off';
            return (
              <article className="card recur" key={r.key}>
                <div className="recur__top">
                  <CatTile cat={catMap.get(r.categoryId)} />
                  <div className="recur__main">
                    <span className="row__title">{r.merchant}</span>
                    <span className="row__sub">{CADENCE[r.cadence]} · {r.occurrences} payments · {days >= 0 ? `next ${fmtRelative(r.nextDate, today).toLowerCase()}` : `was due ${fmtDay(r.nextDate)}`}</span>
                  </div>
                  <div className="recur__amt">
                    <span className="row__amount num">{fmt(r.amount)}</span>
                    <span className="t-xs num">{fmt(r.annual, { whole: true })}/yr</span>
                  </div>
                </div>
                <div className="recur__meta">
                  <StatusChip s={s} />
                  {r.pinned && <span className="chip"><Icon name="PushPin" size={14} weight="fill" />Added by you</span>}
                  {r.change && (
                    <span className={`chip ${r.change.to > r.change.from && r.direction === 'out' ? 'chip--serious' : ''}`}>
                      <Icon name={r.change.to > r.change.from ? 'TrendUp' : 'TrendDown'} size={14} weight="bold" />
                      {fmt(r.change.from)} → {fmt(r.change.to)}
                    </span>
                  )}
                  <span className="grow" />
                  {s && <button className="btn btn--ghost btn--sm" onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key}>History<Icon name="CaretDown" size={14} weight="bold" /></button>}
                  {r.direction === 'out' && (
                    <button className="icon-btn" onClick={() => setRule({ key: r.key, title: r.merchant })} aria-label={`Alert settings for ${r.merchant}`} title="Alert settings">
                      <Icon name={alertsOn ? 'BellRinging' : 'Bell'} size={20} />
                    </button>
                  )}
                  {r.pinned
                    ? <button className="icon-btn" onClick={() => unpinRecurring(r.key, settings)} aria-label={`Stop tracking ${r.merchant}`} title="Stop tracking as recurring"><Icon name="X" size={18} /></button>
                    : <button className="icon-btn" onClick={() => saveSettings({ dismissedRecurring: [...settings.dismissedRecurring, r.key] })} aria-label={`Hide ${r.merchant}`} title="Not recurring? Hide it"><Icon name="X" size={18} /></button>}
                </div>
                {open === r.key && s && (
                  <div className="recur__history">
                    <PayHistory s={s} />
                    <p className="t-small">{scheduleSummary(s)}.</p>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {hidden > 0 && <button className="btn btn--ghost btn--sm" onClick={() => saveSettings({ dismissedRecurring: [] })}>Restore {hidden} hidden payment{hidden === 1 ? '' : 's'}</button>}
      {adding && <PinRecurringSheet mkey={adding.mkey} cadence={adding.cadence} onClose={() => setAdding(null)} />}
      {rule && <AlertRuleSheet itemKey={rule.key} title={rule.title} source="recurring" onClose={() => setRule(null)} />}
    </>
  );
}
