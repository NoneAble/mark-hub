import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { brandOf } from "../lib/colors";

/** MarkHub 图标：书签缎带轮廓，V 型缺口同时读作字母 M（与 public/favicon.svg 同源） */
export function LogoMark({ size = 28 }: { size?: number }) {
  const gid = "logo-tile-" + useId().replace(/[^a-zA-Z0-9-]/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      style={{ flex: "none", display: "block" }}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4983e5" />
          <stop offset="1" stopColor="#2059c8" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="115" fill={`url(#${gid})`} />
      <path
        fill="#fff"
        d="M144 96 H368 Q400 96 400 128 V400 Q400 416 384 416 H358 Q344 416 340.08 402.56 L290.24 231.68 Q288 224 280 224 H232 Q224 224 221.76 231.68 L171.92 402.56 Q168 416 154 416 H128 Q112 416 112 400 V128 Q112 96 144 96 Z"
      />
    </svg>
  );
}

export function LetterAvatar({
  url,
  title,
  size = "md",
}: {
  url?: string;
  title?: string;
  size?: "sm" | "md";
}) {
  const b = brandOf(url || title || "?");
  const cls = size === "sm" ? "letter-avatar sm" : "letter-avatar";
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

/** VuePress-style search trigger: looks like an input, opens the search modal. */
export function SearchField({
  placeholder,
  filled,
  className,
  onActivate,
  /** Show ⌘K / Ctrl+K affordance on the right. */
  shortcutHint,
}: {
  placeholder?: string;
  filled?: boolean;
  className?: string;
  onActivate: () => void;
  shortcutHint?: boolean;
}) {
  return (
    <div
      className={`search-field${filled ? " filled" : ""} search-field-trigger${
        className ? ` ${className}` : ""
      }`}
      onClick={onActivate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <span className="search-icon" aria-hidden>
        <SearchIcon size={19} />
      </span>
      <input
        value=""
        placeholder={placeholder}
        readOnly
        tabIndex={-1}
        onFocus={(e) => {
          e.target.blur();
          onActivate();
        }}
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
  return useModKeyHotkey("k", onOpen, enabled);
}

/** Register ⌘/Ctrl+E to toggle edit mode. */
export function useEditHotkey(onToggle: () => void, enabled = true) {
  return useModKeyHotkey("e", onToggle, enabled);
}

function useModKeyHotkey(key: string, onTrigger: () => void, enabled = true) {
  const triggerRef = useRef(onTrigger);
  triggerRef.current = onTrigger;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== key) return;
      e.preventDefault();
      triggerRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, key]);
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
  const dialogRef = useDialogFocus(open);

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
    // Capture phase: Esc must close only the palette, not a modal underneath;
    // IME guard: Esc/Enter that commit or cancel a composition are not ours.
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
        ref={dialogRef}
        className="search-modal"
        role="dialog"
        aria-modal
        aria-label={placeholder || "Search"}
        tabIndex={-1}
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

/** True while an IME composition is in progress — Esc/Enter then belong to the IME. */
export function isComposingEvent(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const ne = "nativeEvent" in e ? e.nativeEvent : e;
  return ne.isComposing || ne.keyCode === 229;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus management: move focus inside on open, keep Tab cycling within
 * the dialog, and restore focus to the trigger on close.
 */
export function useDialogFocus(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const dialog = ref.current;
    if (!dialog) return;
    const trigger = document.activeElement as HTMLElement | null;
    if (!dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>("[autofocus]") ||
        dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first || dialog).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const current = document.activeElement as HTMLElement | null;
      // A dialog stacked on top of this one (confirm, search palette) owns focus
      if (
        current &&
        !dialog.contains(current) &&
        current.closest('[role="dialog"], [role="alertdialog"]')
      ) {
        return;
      }
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!dialog.contains(current)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [active]);
  return ref;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useDialogFocus(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isComposingEvent(e)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className={`modal${wide ? " modal-lg" : ""}`}
        role="dialog"
        aria-modal
        aria-label={title}
        tabIndex={-1}
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

