import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/data';
import { NAV_GROUPS, SETTINGS_ITEM, titleFor } from '../../app/nav';
import { navigate } from '../../app/router';
import type { Route } from '../../app/router';
import { isDemo, setDemo } from '../../data/db';
import { REVIEW_THRESHOLD } from '../../domain/categorize/engine';
import { Icon } from '../icons';
import { Sheet } from '../components/overlay';
import { AlertsSheet } from './Alerts';

/** The Tally mark: four strokes and the slash through them. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M6 5v14M10.5 5v14M15 5v14M19.5 5v14" />
      <path d="M3 16.5 21 7.5" strokeWidth="2.2" />
    </svg>
  );
}

const TAB_ITEMS = [
  { path: '/', label: 'Home', icon: 'House' },
  { path: '/transactions', label: 'Activity', icon: 'ListBullets' },
  { path: '/import', label: 'Import', icon: 'Plus', fab: true },
  { path: '/budget', label: 'Budget', icon: 'Target' },
] as const;

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const app = useApp();
  const [more, setMore] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const review = useMemo(() => app.txns.filter((t) => t.confidence < REVIEW_THRESHOLD && !t.reviewed && t.catSource !== 'manual').length, [app.txns]);
  const unread = app.alerts.filter((a) => !a.read && a.at <= Date.now()).length;
  const here = route.path;
  const moreActive = !['/', '/transactions', '/import', '/budget'].includes(here);

  const link = (item: { path: string; label: string; icon: string }) => (
    <a key={item.path} className="nav__link" href={`#${item.path}`} aria-current={here === item.path ? 'page' : undefined} title={item.label}>
      <Icon name={item.icon} size={22} weight={here === item.path ? 'fill' : 'duotone'} />
      <span className="nav__text">{item.label}</span>
      {item.path === '/transactions' && review > 0 && <span className="nav__count" aria-label={`${review} to review`}>{review > 99 ? '99+' : review}</span>}
    </a>
  );

  return (
    <div className="shell">
      <aside className="rail" aria-label="Primary">
        <a className="brand" href="#/" aria-label="Tally home">
          <span className="brand__mark"><BrandMark size={20} /></span>
          <span className="brand__name">tally</span>
        </a>
        <nav className="nav">
          {NAV_GROUPS.map((g) => (
            <div className="nav__group" key={g.label}>
              <span className="nav__label t-eyebrow">{g.label}</span>
              {g.items.map(link)}
            </div>
          ))}
        </nav>
        <div className="rail__foot">
          {link(SETTINGS_ITEM)}
          <div className="privacy">
            <Icon name="ShieldCheck" size={20} />
            <span>Everything stays in this browser. Nothing is uploaded, ever.</span>
          </div>
        </div>
      </aside>

      <div className="main">
        {isDemo && (
          <div className="demo-bar" role="status">
            <Icon name="Sparkle" size={16} weight="fill" />
            <span>Sample data: everything here is invented (Netflix, Leeds, Octopus Energy…). Your own statements are untouched.</span>
            <button onClick={() => setDemo(false)}>Switch to my data</button>
          </div>
        )}
        <header className="topbar">
          <a className="topbar__brand" href="#/" aria-label="Tally home">
            <span className="brand__mark brand__mark--sm"><BrandMark size={16} /></span>
          </a>
          <div className="topbar__title"><h1>{titleFor(here)}</h1></div>
          <div className="topbar__actions">
            <button className="icon-btn" onClick={() => setAlertsOpen(true)} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
              <Icon name={unread ? 'BellRinging' : 'Bell'} size={22} />
              {unread > 0 && <span className="icon-btn__dot">{unread > 9 ? '9+' : unread}</span>}
            </button>
            <a className="btn btn--primary btn--sm topbar__import" href="#/import"><Icon name="UploadSimple" size={18} weight="bold" />Import</a>
          </div>
        </header>
        <main className="page" key={here}>{children}</main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {TAB_ITEMS.map((t) => {
          const active = here === t.path;
          if ('fab' in t) {
            return (
              <a key={t.path} href={`#${t.path}`} className="tab tab--fab" aria-label="Import a statement" aria-current={active ? 'page' : undefined}>
                <span className="fab"><Icon name="Plus" size={26} weight="bold" /></span>
              </a>
            );
          }
          return (
            <a key={t.path} href={`#${t.path}`} className="tab" aria-current={active ? 'page' : undefined}>
              <Icon name={t.icon} size={24} weight={active ? 'fill' : 'duotone'} />
              {t.label}
            </a>
          );
        })}
        <button className="tab" onClick={() => setMore(true)} aria-current={moreActive ? 'page' : undefined}>
          <Icon name="Rows" size={24} weight={moreActive ? 'fill' : 'duotone'} />
          More
        </button>
      </nav>

      {more && (
        <Sheet title="More" onClose={() => setMore(false)}>
          <div className="menu">
            {[...NAV_GROUPS.flatMap((g) => g.items), SETTINGS_ITEM]
              .filter((i) => !['/', '/transactions', '/import', '/budget'].includes(i.path))
              .map((i) => (
                <button key={i.path} className="menu__item" aria-selected={here === i.path} onClick={() => { setMore(false); navigate(i.path); }}>
                  <Icon name={i.icon} size={22} />
                  {i.label}
                </button>
              ))}
          </div>
          <div className="privacy"><Icon name="ShieldCheck" size={20} /><span>Everything stays in this browser. Nothing is uploaded, ever.</span></div>
        </Sheet>
      )}
      {alertsOpen && <AlertsSheet onClose={() => setAlertsOpen(false)} />}
    </div>
  );
}
