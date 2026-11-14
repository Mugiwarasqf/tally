import { useEffect, useState, useCallback } from 'react';

/** Minimal hash router: static hosting needs no server rewrites, and installed PWAs keep working offline. */
export type RoutePath = '/' | '/cashflow' | '/transactions' | '/budget' | '/debts' | '/report' | '/recurring' | '/insights' | '/import' | '/settings';

export interface Route {
  path: RoutePath;
  params: URLSearchParams;
}

const parse = (): Route => {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, q = ''] = raw.split('?');
  return { path: (p || '/') as RoutePath, params: new URLSearchParams(q) };
};

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path: RoutePath | string, params?: Record<string, string>): void {
  const q = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
  location.hash = `${path}${q}`;
}

export function useNavigate() {
  return useCallback(navigate, []);
}
