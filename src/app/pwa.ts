import { useSyncExternalStore } from 'react';

/**
 * Install support.
 *
 * Browsers fire `beforeinstallprompt` once, early, and only if the page qualifies as an installable
 * PWA (manifest + service worker + HTTPS or localhost). We catch the event, hold it, and let the UI
 * offer an "Install" button at a moment the user chooses. `useSyncExternalStore` is the idiomatic way
 * to expose such module-level state to React components.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useInstall(): { canInstall: boolean; installed: boolean; install: () => Promise<void> } {
  const can = useSyncExternalStore(subscribe, () => deferred !== null);
  const done = useSyncExternalStore(subscribe, () => installed);
  return {
    canInstall: can,
    installed: done,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      emit();
    },
  };
}

/** Register the service worker (offline shell, notifications, background checks). */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // Tapping a notification asks an already-open Tally window to go to the right page.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; route?: string }>) => {
    if (e.data?.type === 'navigate' && typeof e.data.route === 'string') location.hash = e.data.route;
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is an enhancement; the app works without it */
    });
  });
}
