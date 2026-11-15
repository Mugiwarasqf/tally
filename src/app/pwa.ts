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

/**
 * Where "Add to Home Screen" lives in the browser being used. iPhones never fire
 * `beforeinstallprompt`, and in-app browsers (links opened from a messaging or mail
 * app) cannot install at all, so a precise pointer matters more than a generic one.
 */
export function installHelp(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\/|Snapchat|TikTok|LinkedInApp|Twitter/i.test(ua) || (/Android/i.test(ua) && /; wv\)/.test(ua));
  if (inApp) return `This page is open inside another app, which can’t install it. Open it in ${ios ? 'Safari' : 'Chrome'} first: use the menu and choose “Open in browser”.`;
  if (ios && /CriOS|FxiOS|EdgiOS/i.test(ua)) return 'Tap the Share icon in the address bar, then “Add to Home Screen”. (On older iOS, open this page in Safari to install it.)';
  if (ios) return 'In Safari, tap the Share button (the square with an arrow; on newer iPhones it is inside the ⋯ menu next to the address bar), then scroll down the list and choose “Add to Home Screen”.';
  if (/SamsungBrowser/i.test(ua)) return 'Tap the menu (☰), then “Add page to” → “Home screen”.';
  if (/Firefox/i.test(ua) && /Android/i.test(ua)) return 'Tap the menu (⋮), then “Install” or “Add to Home screen”.';
  if (/Android/i.test(ua)) return 'In Chrome, tap the menu (⋮) at the top right, then “Add to Home screen” or “Install app”.';
  return 'Use your browser’s “Install app” option (an install icon in the address bar, or the browser menu) to put Tally on this device.';
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
