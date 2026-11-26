import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, ErrorIcon, InfoIcon, OkIcon, WarnIcon } from "../icons";
import { useApp } from "../../state/app";

type Variant = "default" | "primary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "small" | "normal" | "large";
  icon?: ReactNode;
  /** Explains the button; when the button is disabled, explains why. */
  tip?: string;
  busy?: boolean;
}

export function Button({ variant = "default", size = "normal", icon, tip, busy, className = "", children, disabled, ...rest }: ButtonProps) {
  const cls = ["btn", variant !== "default" && `btn--${variant}`, size !== "normal" && `btn--${size}`, className].filter(Boolean).join(" ");
  const button = (
    <button type="button" className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...(tip && !disabled ? { "data-tip": tip } : {})} {...rest}>
      {busy ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
  return disabled && tip ? (
    <span data-tip={tip} style={{ display: "inline-flex" }}>
      {button}
    </span>
  ) : (
    button
  );
}

export function IconButton({ label, tip, small, className = "", disabled, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tip?: string; small?: boolean }) {
  const button = (
    <button type="button" aria-label={label} data-tip={disabled ? undefined : (tip ?? label)} className={`icon-btn ${small ? "icon-btn--small" : ""} ${className}`} disabled={disabled} {...rest}>
      {children}
    </button>
  );
  return disabled ? (
    <span data-tip={tip ?? label} style={{ display: "inline-flex" }}>
      {button}
    </span>
  ) : (
    button
  );
}

/** One tooltip for the whole app: any element with data-tip shows it on hover or keyboard focus. */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer = 0;
    const show = (target: EventTarget | null) => {
      const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
      window.clearTimeout(timer);
      if (!el) {
        setTip(null);
        return;
      }
      const text = el.dataset["tip"];
      if (!text) return;
      timer = window.setTimeout(() => {
        setPos(null);
        setTip({ text, rect: el.getBoundingClientRect() });
      }, 380);
    };
    const over = (e: Event) => show(e.target);
    const out = () => {
      window.clearTimeout(timer);
      setTip(null);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("pointerdown", out);
    document.addEventListener("focusout", out);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("pointerdown", out);
      document.removeEventListener("focusout", out);
    };
  }, []);
  // Measure first, then place: beside the navigation rail, otherwise below (or above) the anchor, always inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const r = tip.rect;
    const margin = 8;
    let left: number;
    let top: number;
    if (r.right < 72) {
      left = r.right + margin;
      top = r.top + r.height / 2 - h / 2;
    } else {
      left = r.left + r.width / 2 - w / 2;
      top = r.bottom + 7 + h + margin < window.innerHeight ? r.bottom + 7 : r.top - 7 - h;
    }
    setPos({ left: Math.min(Math.max(margin, left), window.innerWidth - w - margin), top: Math.min(Math.max(margin, top), window.innerHeight - h - margin) });
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {tip.text}
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.kind === "success" ? <OkIcon /> : t.kind === "error" ? <ErrorIcon /> : <InfoIcon />}
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            {t.detail && <div className="toast__detail">{t.detail}</div>}
          </div>
          <IconButton small label="Dismiss" onClick={() => dismiss(t.id)}>
            <CloseIcon />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/**
 * A modal dialog. Clicking outside it never closes it (a stray click lost typed text and plans); the close
 * button does, and so does Esc unless `keepOnEscape` is set, for dialogs holding work in progress.
 */
export function Dialog({ title, children, footer, onClose, wide, keepOnEscape }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean; keepOnEscape?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const keepRef = useRef(keepOnEscape);
  keepRef.current = keepOnEscape;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !keepRef.current) closeRef.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    // A dialog can mark what starts focused (data-autofocus); otherwise the first field or the main button does. Once, on opening.
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("input, select, textarea, button.btn--primary"))?.focus();
  }, []);
  return createPortal(
    <div className="scrim">
      <div className={`dialog ${wide ? "dialog--wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={ref}>
        <div className="dialog__header">
          <div className="dialog__title">{title}</div>
          <IconButton small label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const Icon = kind === "warn" ? WarnIcon : kind === "error" ? ErrorIcon : kind === "ok" ? OkIcon : InfoIcon;
  return (
    <div className={`notice notice--${kind}`}>
      <Icon />
      <div>{children}</div>
    </div>
  );
}

export function Field({ label, help, error, children, htmlFor }: { label: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <div className="field__error">{error}</div> : help ? <div className="field__help">{help}</div> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Number input that commits on blur or Enter and refuses non-numbers. */
export function NumberInput({ value, onCommit, step = 1, min, max, id, ariaLabel, disabled }: { value: number; onCommit: (n: number) => void; step?: number; min?: number; max?: number; id?: string; ariaLabel?: string; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) {
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
      if (clamped !== value) onCommit(clamped);
      setText(String(clamped));
    } else setText(String(value));
  };
  return <input id={id} aria-label={ariaLabel} className="input input--mono" inputMode="decimal" value={text} step={step} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

/** Text input that commits on blur or Enter. */
export function TextInput({ value, onCommit, id, placeholder, mono, ariaLabel, maxLength }: { value: string; onCommit: (s: string) => void; id?: string; placeholder?: string; mono?: boolean; ariaLabel?: string; maxLength?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  const commit = () => text !== value && onCommit(text);
  return <input id={id} aria-label={ariaLabel} maxLength={maxLength} className={`input ${mono ? "input--mono" : ""}`} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="stack" style={{ alignItems: "center" }}>
        {icon}
        <h3>{title}</h3>
        {children && <p>{children}</p>}
        {action}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} data-tip={o.tip} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
