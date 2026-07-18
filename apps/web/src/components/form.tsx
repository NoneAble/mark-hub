import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";

/* ---------- shared helpers ---------- */

export const TAG_PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#64748b",
];

function useClickOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [onClose]);
  return ref;
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={`combo-caret${open ? " open" : ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ColorDot({ color, size = 10 }: { color?: string | null; size?: number }) {
  return (
    <span
      className={`color-dot${color ? "" : " empty"}`}
      style={{ width: size, height: size, background: color || "transparent" }}
      aria-hidden
    />
  );
}

/* ---------- Field wrapper ---------- */

export function Field({
  label,
  children,
  hint,
  row,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  hint?: React.ReactNode;
  row?: boolean;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {row ? <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>{children}</div> : children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/* ---------- Combobox (single select, filter + optional create) ---------- */

export type ComboOption = {
  value: string;
  label: string;
  hint?: string;
  dot?: string | null;
  pad?: number;
  isNew?: boolean;
};

export function Combobox({
  value,
  options,
  onChange,
  onCreate,
  placeholder,
  creatable = false,
  disabled = false,
  testId,
}: {
  value: string;
  options: ComboOption[];
  onChange: (v: string) => void;
  /** Return the value to select for the newly created entry (or null to reject). */
  onCreate?: (name: string) => string | null;
  placeholder?: string;
  creatable?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const close = useCallback(() => {
    setOpen(false);
    setTyping(false);
    setQuery("");
  }, []);
  const rootRef = useClickOutside(close);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!typing || !q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query, typing]);

  const canCreate =
    creatable &&
    typing &&
    query.trim() &&
    !options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase());

  useEffect(() => setActive(0), [query, open]);
  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function pick(v: string) {
    onChange(v);
    close();
  }

  function createFromQuery() {
    const name = query.trim();
    if (!name || !onCreate) return;
    const v = onCreate(name);
    if (v !== null) pick(v);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (open) {
        // Close only the dropdown, not an enclosing modal
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    const total = filtered.length + (canCreate ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(total - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (canCreate && active === filtered.length) {
        createFromQuery();
      } else if (filtered[active]) {
        pick(filtered[active].value);
      } else if (canCreate) {
        createFromQuery();
      }
    }
  }

  return (
    <div className={`combo${disabled ? " disabled" : ""}`} ref={rootRef} data-testid={testId}>
      <div
        className={`combo-control input${open ? " focus" : ""}`}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {selected?.dot !== undefined ? <ColorDot color={selected?.dot} /> : null}
        <input
          ref={inputRef}
          className="combo-input"
          value={typing ? query : selected?.label || ""}
          placeholder={selected ? selected.label : placeholder}
          disabled={disabled}
          onChange={(e) => {
            setTyping(true);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
        />
        <Caret open={open} />
      </div>
      {open ? (
        <div className="combo-menu" role="listbox" ref={listRef}>
          {!filtered.length && !canCreate ? (
            <div className="combo-empty">{t("searchNoResults")}</div>
          ) : null}
          {filtered.map((o, idx) => (
            <button
              key={o.value}
              type="button"
              className={`combo-option${idx === active ? " active" : ""}${
                o.value === value ? " selected" : ""
              }`}
              data-idx={idx}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(idx)}
              onClick={() => pick(o.value)}
            >
              <span style={{ paddingLeft: o.pad || 0 }} className="combo-option-label">
                {o.dot !== undefined ? <ColorDot color={o.dot} /> : null}
                {o.label}
                {o.isNew ? <span className="combo-new">{t("newSuffix")}</span> : null}
              </span>
              {o.hint ? <span className="combo-hint">{o.hint}</span> : null}
              {o.value === value ? <span className="combo-check">✓</span> : null}
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className={`combo-option create${active === filtered.length ? " active" : ""}`}
              data-idx={filtered.length}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={createFromQuery}
            >
              <span className="combo-option-label">
                ＋ {query.trim()}
                <span className="combo-new">{t("newSuffix")}</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- TagPicker (multi select + create) ---------- */

export type TagOption = { name: string; color?: string | null; isNew?: boolean };

export function TagPicker({
  selected,
  options,
  onChange,
  onCreate,
  placeholder,
}: {
  selected: string[];
  options: TagOption[];
  onChange: (names: string[]) => void;
  /** Called when the user creates a tag that doesn't exist yet. */
  onCreate?: (name: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  const rootRef = useClickOutside(close);

  const byName = useMemo(() => new Map(options.map((o) => [o.name, o])), [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
    return base;
  }, [options, query]);

  const canCreate =
    !!query.trim() && !options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase());

  useEffect(() => setActive(0), [query, open]);

  function toggle(name: string) {
    onChange(
      selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name],
    );
    setQuery("");
    inputRef.current?.focus();
  }

  function createFromQuery() {
    const name = query.trim();
    if (!name) return;
    if (!byName.has(name)) onCreate?.(name);
    if (!selected.includes(name)) onChange([...selected, name]);
    setQuery("");
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (open) {
        // Close only the dropdown, not an enclosing modal
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    if (e.key === "Backspace" && !query && selected.length) {
      onChange(selected.slice(0, -1));
      return;
    }
    const total = filtered.length + (canCreate ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(total - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (canCreate && active === filtered.length) createFromQuery();
      else if (filtered[active]) toggle(filtered[active].name);
      else if (canCreate) createFromQuery();
    }
  }

  return (
    <div className="combo" ref={rootRef}>
      <div
        className="combo-control input tagpicker"
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {selected.map((name) => {
          const o = byName.get(name);
          return (
            <span key={name} className="tagpick-chip" style={tagChipStyle(o?.color)}>
              <ColorDot color={o?.color} size={8} />
              {name}
              {o?.isNew ? <span className="combo-new">{t("newSuffix")}</span> : null}
              <button
                type="button"
                className="tagpick-x"
                aria-label={`remove ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(selected.filter((x) => x !== name));
                }}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="combo-input"
          value={query}
          placeholder={selected.length ? "" : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <Caret open={open} />
      </div>
      {open ? (
        <div className="combo-menu" role="listbox">
          {!filtered.length && !canCreate ? (
            <div className="combo-empty">{t("searchNoResults")}</div>
          ) : null}
          {filtered.map((o, idx) => (
            <button
              key={o.name}
              type="button"
              className={`combo-option${idx === active ? " active" : ""}${
                selected.includes(o.name) ? " selected" : ""
              }`}
              role="option"
              aria-selected={selected.includes(o.name)}
              onMouseEnter={() => setActive(idx)}
              onClick={() => toggle(o.name)}
            >
              <span className="combo-option-label">
                <ColorDot color={o.color} />
                {o.name}
                {o.isNew ? <span className="combo-new">{t("newSuffix")}</span> : null}
              </span>
              {selected.includes(o.name) ? <span className="combo-check">✓</span> : null}
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className={`combo-option create${active === filtered.length ? " active" : ""}`}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={createFromQuery}
            >
              <span className="combo-option-label">
                ＋ {query.trim()}
                <span className="combo-new">{t("newSuffix")}</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function tagChipStyle(color?: string | null): React.CSSProperties | undefined {
  if (!color) return undefined;
  return {
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    color: `color-mix(in srgb, ${color} 80%, var(--text))`,
  };
}

/* ---------- ColorPicker ---------- */

export function ColorPicker({
  value,
  onChange,
  title,
}: {
  value: string | null;
  onChange: (c: string | null) => void;
  title?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useClickOutside(useCallback(() => setOpen(false), []));
  return (
    <div className="combo color-picker" ref={rootRef}>
      <button
        type="button"
        className="btn color-picker-btn"
        title={title || t("color")}
        aria-label={title || t("color")}
        onClick={() => setOpen((v) => !v)}
      >
        <ColorDot color={value} size={14} />
        <Caret open={open} />
      </button>
      {open ? (
        <div className="combo-menu color-menu">
          <div className="color-grid">
            {TAG_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-cell${value === c ? " active" : ""}`}
                style={{ background: c }}
                aria-label={c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="combo-option"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <span className="combo-option-label">
              <ColorDot color={null} />
              {t("noColor")}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Switch ---------- */

export function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  testId?: string;
}) {
  return (
    <label className="switch-wrap">
      <input
        type="checkbox"
        className="switch-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
      {label ? <span className="switch-label">{label}</span> : null}
    </label>
  );
}

/* ---------- Segmented control ---------- */

export function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: React.ReactNode }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`segmented-item${value === o.value ? " active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Confirm dialog ---------- */

type ConfirmOpts = {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Extra content rendered between message and buttons (e.g. delete-mode picker). */
  body?: React.ReactNode;
};

export function useConfirm() {
  const { t } = useI18n();
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<(ok: boolean) => void>();

  const confirm = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const done = useCallback((ok: boolean) => {
    setOpts(null);
    resolver.current?.(ok);
  }, []);

  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, done]);

  const element = opts ? (
    <div className="modal-backdrop" onClick={() => done(false)} role="presentation">
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{opts.title || t("confirmTitle")}</div>
        <div className="confirm-message">{opts.message}</div>
        {opts.body}
        <div className="row" style={{ marginTop: 18, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => done(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className={`btn ${opts.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => done(true)}
          >
            {opts.confirmLabel || t("delete")}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmElement: element } as const;
}

/* ---------- Bookmark icon (img with letter-avatar fallback) ---------- */

export function FaviconImg({
  src,
  size = 32,
  radius = 8,
}: {
  src: string;
  size?: number;
  radius?: number;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) return null;
  return (
    <img
      src={src}
      width={size}
      height={size}
      style={{ borderRadius: radius, objectFit: "contain", flex: "none", background: "var(--panel2)" }}
      onError={() => setBroken(true)}
      alt=""
      loading="lazy"
    />
  );
}
