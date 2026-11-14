import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';

/**
 * Sheet: a bottom sheet on phones, a centred dialog on larger screens.
 * Escape and backdrop-click close it; focus moves in on open and returns on close.
 */
export function Sheet(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  label?: string;
}) {
  const { title, onClose, children, footer, wide } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      const a = document.activeElement;
      if (e.shiftKey && a === f[0]) { e.preventDefault(); f.at(-1)!.focus(); }
      else if (!e.shiftKey && a === f.at(-1)) { e.preventDefault(); f[0]!.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet${wide ? ' sheet--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet__head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-close>
            <Icon name="X" size={20} weight="bold" />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---- toasts -----------------------------------------------------------------------------
interface ToastItem { id: number; text: string; action?: { label: string; run: () => void } }
const ToastCtx = createContext<(text: string, action?: ToastItem['action']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, action?: ToastItem['action']) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-2), { id, text, action }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), action ? 7000 : 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {items.map((t) => (
            <div className="toast" key={t.id}>
              <span>{t.text}</span>
              {t.action && <button onClick={() => { t.action!.run(); setItems((s) => s.filter((x) => x.id !== t.id)); }}>{t.action.label}</button>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

// ---- confirmation ------------------------------------------------------------------------
interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}
type AskFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<AskFn>(async () => false);

/** `const ask = useConfirm(); if (await ask({ title: 'Delete?' })) …` — an in-app replacement for window.confirm. */
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback<AskFn>((o) => new Promise((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Sheet
          title={state.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => close(false)}>Cancel</button>
              <button className={`btn ${state.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => close(true)}>{state.confirmLabel ?? 'Confirm'}</button>
            </>
          }
        >
          {state.body && <p className="t-small">{state.body}</p>}
        </Sheet>
      )}
    </ConfirmCtx.Provider>
  );
}
