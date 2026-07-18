import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useClickOutside } from "./form";
import type { SettingsTab } from "./SettingsModal";

/** Top-right avatar dropdown: settings entries + logout. */
export function UserMenu({
  username,
  onOpenSettings,
  onLogout,
}: {
  username?: string;
  onOpenSettings: (tab: SettingsTab) => void;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useClickOutside(useCallback(() => setOpen(false), []));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function openTab(tab: SettingsTab) {
    setOpen(false);
    onOpenSettings(tab);
  }

  const entries: [SettingsTab, string][] = [
    ["account", t("accountTab")],
    ["backup", t("backupTab")],
    ["webdav", t("webdavTab")],
    ["s3", t("s3Tab")],
  ];

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        type="button"
        className="btn topbar-btn user-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("settings")}
        data-testid="user-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-avatar" aria-hidden>
          {(username || "?").slice(0, 1).toUpperCase()}
        </span>
      </button>
      {open ? (
        <div className="menu" role="menu">
          {username ? <div className="menu-label">{username}</div> : null}
          {entries.map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              className="menu-item"
              role="menuitem"
              data-testid={`menu-${tab}`}
              onClick={() => openTab(tab)}
            >
              {label}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            className="menu-item danger"
            role="menuitem"
            data-testid="menu-logout"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            {t("logout")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
