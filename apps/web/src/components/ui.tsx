import React, { useEffect, useMemo, useRef, useState } from "react";
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

function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  const p = platform || navigator.platform || "";
  return /Mac|iPhone|iPad|iPod/i.test(p) || /Mac OS X|iPhone|iPad|iPod/i.test(ua);
}

/** Search / magnifying-glass icon (SVG, scales cleanly). */
export function SearchIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="search-icon-svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

/** Keyboard shortcut chip, e.g. ⌘ K / Ctrl K. */
export function KbdHint({ className }: { className?: string }) {
  const apple = isApplePlatform();
  return (
    <span className={`kbd-hint${className ? ` ${className}` : ""}`} aria-hidden>
      {apple ? (
        <>
          <kbd className="kbd">⌘</kbd>
          <kbd className="kbd">K</kbd>
        </>
      ) : (
        <>
          <kbd className="kbd">Ctrl</kbd>
          <kbd className="kbd">K</kbd>
        </>
      )}
    </span>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  filled,
  style,
  className,
  testId,
  /** When set, field acts as a VuePress-style trigger (opens search modal). */
  onActivate,
  /** Show ⌘K / Ctrl+K affordance on the right. */
  shortcutHint,
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  filled?: boolean;
  style?: React.CSSProperties;
  className?: string;
  testId?: string;
  onActivate?: () => void;
  shortcutHint?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  const trigger = Boolean(onActivate);
  return (
    <div
      className={`search-field${filled ? " filled" : ""}${trigger ? " search-field-trigger" : ""}${
        className ? ` ${className}` : ""
      }`}
      style={style}
      onClick={trigger ? onActivate : undefined}
      role={trigger ? "button" : undefined}
      tabIndex={trigger ? 0 : undefined}
      onKeyDown={
        trigger
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate?.();
              }
            }
          : undefined
      }
    >
      <span className="search-icon" aria-hidden>
        <SearchIcon size={19} />
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testId}
        readOnly={trigger}
        tabIndex={trigger ? -1 : undefined}
        onFocus={
          trigger
            ? (e) => {
                e.target.blur();
                onActivate?.();
              }
            : undefined
        }
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        aria-label={placeholder}
      />
      {shortcutHint ? <KbdHint /> : null}
    </div>
  );
}

/** Highlight all case-insensitive occurrences of `query` inside `text`. */
export function highlightText(text: string, query: string): React.ReactNode {
  if (!text) return text;
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const qq = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qq, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="search-highlight">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts.length === 1 ? parts[0] : parts;
}

export type SearchableItem = {
  id: string;
  title: string;
  url: string;
  description?: string | null;
  tags?: Array<string | { name: string }> | null;
};

function itemMatches(item: SearchableItem, qq: string): boolean {
  if (!qq) return true;
  const tags = (item.tags || []).map((x) => (typeof x === "string" ? x : x.name)).join(" ");
  return (
    item.title.toLowerCase().includes(qq) ||
    item.url.toLowerCase().includes(qq) ||
    (item.description || "").toLowerCase().includes(qq) ||
    tags.toLowerCase().includes(qq)
  );
}

/** Register ⌘/Ctrl+K to open search (VuePress-style). */
export function useSearchHotkey(onOpen: () => void, enabled = true) {
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "k") return;
      // Skip when a real modal form input is focused and user is typing a shortcut conflict — still open search like VuePress
      e.preventDefault();
      openRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export function SearchModal({
  open,
  onClose,
  items,
  initialQuery = "",
  placeholder,
  emptyLabel,
  openLabel,
}: {
  open: boolean;
  onClose: () => void;
  items: SearchableItem[];
  initialQuery?: string;
  placeholder?: string;
  emptyLabel?: string;
  openLabel?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ(initialQuery);
    setActive(0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(t);
    };
  }, [open, initialQuery]);

  const results = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const matched = items.filter((it) => itemMatches(it, qq));
    return matched.slice(0, 60);
  }, [items, q]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const item = results[active];
        if (item) {
          e.preventDefault();
          window.open(item.url, "_blank", "noopener,noreferrer");
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, results, active]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open, results]);

  if (!open) return null;

  return (
    <div className="search-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="search-modal"
        role="dialog"
        aria-modal
        aria-label={placeholder || "Search"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-modal-input-row">
          <span className="search-icon" aria-hidden>
            <SearchIcon size={20} />
          </span>
          <input
            ref={inputRef}
            className="search-modal-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            data-testid="search-modal-input"
            autoComplete="off"
            spellCheck={false}
          />
          <KbdHint className="search-modal-kbd" />
          <button type="button" className="search-modal-esc" onClick={onClose} aria-label="Close">
            Esc
          </button>
        </div>
        <div className="search-modal-body" ref={listRef} role="listbox">
          {!results.length ? (
            <div className="search-modal-empty">{emptyLabel || "No results"}</div>
          ) : (
            results.map((item, idx) => {
              const b = brandOf(item.url);
              const tags = (item.tags || []).map((x) => (typeof x === "string" ? x : x.name));
              return (
                <a
                  key={item.id}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`search-modal-item${idx === active ? " active" : ""}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === active}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => onClose()}
                >
                  <div
                    className="search-modal-avatar"
                    style={{ background: b.color }}
                    aria-hidden
                  >
                    {b.letter}
                  </div>
                  <div className="search-modal-item-main">
                    <div className="search-modal-title">{highlightText(item.title, q)}</div>
                    <div className="search-modal-url">{highlightText(b.domain || item.url, q)}</div>
                    {item.description ? (
                      <div className="search-modal-desc">{highlightText(item.description, q)}</div>
                    ) : null}
                    {tags.length ? (
                      <div className="search-modal-tags">
                        {tags.slice(0, 6).map((tg) => (
                          <span key={tg} className="tag-chip">
                            #{highlightText(tg, q)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span className="search-modal-open muted-sm">{openLabel || "Open"}</span>
                </a>
              );
            })
          )}
        </div>
        <div className="search-modal-footer">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> open
          </span>
          <span>
            <kbd className="kbd">esc</kbd> close
          </span>
        </div>
      </div>
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

