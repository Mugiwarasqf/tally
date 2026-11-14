import { useState } from 'react';
import { useApp } from '../../app/data';
import { navigate } from '../../app/router';
import { db } from '../../data/db';
import { enableBackgroundChecks, notificationSupport, requestPermission, showSystem } from '../../data/notify';
import { saveSettings } from '../../data/settings';
import type { AlertItem } from '../../domain/types';
import { Icon } from '../icons';
import { Sheet, useToast } from '../components/overlay';
import { Switch } from '../components/bits';

const KIND_ICON: Record<AlertItem['kind'], string> = {
  budget: 'Gauge', bill: 'ArrowsClockwise', debt: 'Scales', statement: 'UploadSimple', weekly: 'CalendarBlank', unusual: 'Warning', missed: 'WarningCircle',
};

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

/** Notification centre. Works everywhere; OS-level notifications are an optional extra on top. */
export function AlertsSheet({ onClose }: { onClose: () => void }) {
  const { alerts, settings } = useApp();
  const toast = useToast();
  const [perm, setPerm] = useState(notificationSupport());
  const due = alerts.filter((a) => a.at <= Date.now());
  const upcoming = alerts.filter((a) => a.at > Date.now()).sort((a, b) => a.at - b.at);

  const open = async (a: AlertItem) => {
    await db.alerts.update(a.id, { read: true });
    onClose();
    navigate(a.route);
  };

  const enable = async () => {
    const p = await requestPermission();
    setPerm(p);
    if (p === 'granted') {
      await saveSettings({ notifications: { ...settings.notifications, enabled: true } });
      const bg = await enableBackgroundChecks();
      await showSystem({ id: 'welcome', title: 'Notifications are on', body: bg ? 'Tally will also check in the background when installed.' : 'You’ll get alerts while Tally is open.', route: '/' });
      toast(bg ? 'Notifications on, including background checks' : 'Notifications on');
    } else if (p === 'denied') toast('Notifications are blocked in your browser settings');
  };

  return (
    <Sheet
      title="Notifications"
      onClose={onClose}
      footer={due.some((a) => !a.read) ? <button className="btn btn--ghost" onClick={async () => { await db.alerts.where('at').belowOrEqual(Date.now()).modify({ read: true }); }}>Mark all read</button> : undefined}
    >
      {perm !== 'granted' && perm !== 'unsupported' && (
        <div className="banner banner--brand">
          <Icon name="BellRinging" size={20} />
          <div className="banner__body">
            <strong>Get a nudge on your phone or desktop</strong>
            <div className="t-small">Budget limits, bills due, debt payments and a Monday recap. All worked out on this device, never sent anywhere.</div>
          </div>
          {perm === 'default' && <button className="btn btn--primary btn--sm" onClick={enable}>Turn on</button>}
        </div>
      )}
      {perm === 'denied' && <p className="t-xs">Notifications are blocked for this site. Allow them in your browser’s site settings to turn them on.</p>}
      {perm === 'granted' && (
        <label className="split">
          <span className="t-label">System notifications</span>
          <Switch checked={settings.notifications.enabled} label="System notifications" onChange={(v) => saveSettings({ notifications: { ...settings.notifications, enabled: v } })} />
        </label>
      )}

      {due.length === 0 && <p className="t-small" style={{ padding: 'var(--s-6) 0', textAlign: 'center' }}>Nothing yet. Alerts appear here when a budget is close, a bill is due, or something looks off.</p>}
      <ul className="list" aria-label="Alerts">
        {due.map((a) => (
          <li key={a.id}>
            <button className={`row${a.read ? ' row--read' : ''}`} onClick={() => open(a)}>
              <span className="tile tile--ink"><Icon name={KIND_ICON[a.kind]} size={20} /></span>
              <span className="row__main">
                <span className="row__title">{a.title}</span>
                <span className="row__sub" style={{ whiteSpace: 'normal' }}>{a.body}</span>
              </span>
              <span className="row__end t-xs">{!a.read && <i className="unread" aria-label="Unread" />}{ago(a.at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {upcoming.length > 0 && (
        <>
          <span className="t-eyebrow">Coming up</span>
          <ul className="list">
            {upcoming.slice(0, 4).map((a) => (
              <li key={a.id} className="row row--hover">
                <span className="tile tile--ink"><Icon name={KIND_ICON[a.kind]} size={20} /></span>
                <span className="row__main"><span className="row__title">{a.title}</span><span className="row__sub">{new Date(a.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></span>
                <span />
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}
