import React, { useEffect, useState } from "react";
import { brandOf } from "../lib/colors";

export function LogoMark({ size = 28 }: { size?: number }) {
  const r = Math.round(size * 0.28);
  return (
    <div
      className="logo-mark"
      style={{ width: size, height: size, borderRadius: r, fontSize: Math.round(size * 0.52) }}
      aria-hidden
    >
      M
    </div>
  );
}

export function LetterAvatar({
  url,
  title,
  size = "md",
}: {
  url?: string;
  title?: string;
  size?: "sm" | "md" | "lg";
}) {
  const b = brandOf(url || title || "?");
  const cls = size === "lg" ? "letter-avatar lg" : size === "sm" ? "letter-avatar sm" : "letter-avatar";
  return (
    <div className={cls} style={{ background: b.color }} title={b.domain}>
      {b.letter}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  filled,
  style,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  filled?: boolean;
  style?: React.CSSProperties;
  testId?: string;
}) {
  return (
    <div className={`search-field${filled ? " filled" : ""}`} style={style}>
      <span className="search-icon" aria-hidden>
        ⌕
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testId}
      />
    </div>
  );
}

export function TagList({ tags }: { tags?: Array<string | { name: string }> | null }) {
  if (!tags?.length) return null;
  return (
    <>
      {tags.map((tg, i) => {
        const name = typeof tg === "string" ? tg : tg.name;
        return (
          <span key={`${name}-${i}`} className="tag-chip">
            #{name}
          </span>
        );
      })}
    </>
  );
}

export function StatCard({
  label,
  value,
  delta,
  deltaColor,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  deltaColor?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta ? (
        <div className="stat-delta" style={deltaColor ? { color: deltaColor } : undefined}>
          {delta}
        </div>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: sub ? 16 : 18 }}>
      <div className="page-header">
        <h1 className="page-title">{title}</h1>
        {actions ? <div className="row spacer">{actions}</div> : null}
      </div>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{title}</div>
        <div className="stack">{children}</div>
        {footer ? <div className="row" style={{ marginTop: 18, justifyContent: "flex-end" }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}

export function useToast(ms = 2200) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), ms);
    return () => window.clearTimeout(t);
  }, [msg, ms]);
  return { toast: msg, showToast: setMsg } as const;
}

export function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  count?: number | string;
}) {
  return (
    <button type="button" className={`chip${active ? " active" : ""}`} onClick={onClick}>
      {children}
      {count !== undefined ? <span className="chip-count">{count}</span> : null}
    </button>
  );
}

export function DomainBar({ host, n, max }: { host: string; n: number; max: number }) {
  const pct = max > 0 ? Math.max(6, Math.round((n / max) * 100)) : 0;
  const op = max > 0 ? 0.35 + (n / max) * 0.65 : 0.4;
  return (
    <div className="domain-bar-row">
      <span className="mono" style={{ width: 180, flex: "none", color: "var(--text2)" }}>
        {host}
      </span>
      <div className="domain-bar-track">
        <div className="domain-bar-fill" style={{ width: `${pct}%`, opacity: op }} />
      </div>
      <span style={{ fontSize: 11.5, color: "var(--text3)", width: 24, textAlign: "right" }}>{n}</span>
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-hidden />;
}
