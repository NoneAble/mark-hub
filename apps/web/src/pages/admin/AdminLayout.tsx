import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../i18n";

export function AdminLayout() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [navOpen, setNavOpen] = useState(false);
  const links = [
    ["", t("overview")],
    ["bookmarks", t("bookmarks")],
    ["folders", t("folders")],
    ["tags", t("tags")],
    ["backup", t("backup")],
    ["ai", t("ai")],
    ["mcp", t("mcp")],
    ["settings", t("settings")],
    ["account", t("account")],
    ["about", t("about")],
  ] as const;

  return (
    <div className="layout-shell">
      <header className="mobile-nav-bar">
        <button
          type="button"
          className="btn mobile-nav-toggle"
          aria-label="Menu"
          onClick={() => setNavOpen((v) => !v)}
        >
          ☰
        </button>
        <strong>
          {t("appName")} · {t("admin")}
        </strong>
      </header>
      {navOpen ? (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div style={{ fontWeight: 700, marginBottom: 16, padding: "0 12px" }}>
          {t("appName")} · {t("admin")}
        </div>
        {links.map(([path, label]) => (
          <NavLink
            key={path}
            to={path ? `/admin/${path}` : "/admin"}
            end={!path}
            className={({ isActive }) => (isActive ? "active" : undefined)}
            onClick={() => setNavOpen(false)}
          >
            {label}
          </NavLink>
        ))}
        <div style={{ marginTop: 24, padding: "0 12px" }} className="muted">
          {user?.username}
        </div>
        <button
          className="btn"
          style={{ margin: "8px 12px", width: "calc(100% - 24px)" }}
          onClick={logout}
        >
          {t("logout")}
        </button>
        <NavLink to="/app" onClick={() => setNavOpen(false)}>
          {t("workbench")}
        </NavLink>
        <NavLink to="/" onClick={() => setNavOpen(false)}>
          {t("publicNav")}
        </NavLink>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
