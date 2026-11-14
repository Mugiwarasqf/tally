import { Suspense, lazy, useEffect } from 'react';
import { DataProvider, useApp } from './app/data';
import { useRoute } from './app/router';
import type { RoutePath } from './app/router';
import { isDemo } from './data/db';
import { loadDemo } from './data/demo';
import { Home } from './pages/Home';
import { PageBoundary } from './ui/components/PageBoundary';
import { ConfirmProvider, ToastProvider } from './ui/components/overlay';
import { BrandMark, Shell } from './ui/layout/Shell';

// Each page is its own chunk, loaded when first visited. Home stays eager: it's the landing screen.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));

const PAGES: Record<RoutePath, React.ComponentType> = {
  '/': Home,
  '/cashflow': page(() => import('./pages/Cashflow'), 'Cashflow'),
  '/transactions': page(() => import('./pages/Transactions'), 'Transactions'),
  '/budget': page(() => import('./pages/Budget'), 'Budget'),
  '/debts': page(() => import('./pages/Debts'), 'Debts'),
  '/recurring': page(() => import('./pages/Recurring'), 'Recurring'),
  '/report': page(() => import('./pages/Report'), 'Report'),
  '/insights': page(() => import('./pages/Insights'), 'Insights'),
  '/import': page(() => import('./pages/Import'), 'Import'),
  '/settings': page(() => import('./pages/Settings'), 'Settings'),
};

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading Tally">
      <span className="brand__mark brand__mark--lg"><BrandMark size={32} /></span>
    </div>
  );
}

function Gate() {
  const app = useApp();
  const route = useRoute();

  // Demo mode lives in its own database; fill it the first time it's opened.
  useEffect(() => {
    if (isDemo && app.ready && app.accounts.length === 0) void loadDemo();
  }, [app.ready, app.accounts.length]);

  // Block body on purpose: in current Chromium `scrollTo` returns a Promise, and React would treat a returned value as the cleanup.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.path]);

  if (!app.ready) return <Splash />;
  const Page = PAGES[route.path] ?? Home;
  return (
    <Shell route={route}>
      <PageBoundary>
        <Suspense fallback={<div className="page__loading" aria-busy="true" />}>
          <Page />
        </Suspense>
      </PageBoundary>
    </Shell>
  );
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <DataProvider>
          <Gate />
        </DataProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
