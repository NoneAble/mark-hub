import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useI18n } from "../../i18n";
import { useAuth } from "../../lib/auth";

export function AppLayout() {
  const { t } = useI18n();
  const { logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const links = [
    ["", t("workbench")],
    ["cleaner", t("cleaner")],
    ["compare", t("compare")],
    ["ai", t("ai")],
    ["boards", t("boards")],
    ["discover", t("discover")],
    ["settings", t("settings")],
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
        <strong>{t("appName")}</strong>
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
        <div style={{ fontWeight: 700, marginBottom: 16, padding: "0 12px" }}>{t("appName")}</div>
        {links.map(([path, label]) => (
          <NavLink
            key={path}
            end={!path}
            to={path ? `/app/${path}` : "/app"}
            className={({ isActive }) => (isActive ? "active" : undefined)}
            onClick={() => setNavOpen(false)}
          >
            {label}
          </NavLink>
        ))}
        <NavLink to="/admin" onClick={() => setNavOpen(false)}>
          {t("admin")}
        </NavLink>
        <NavLink to="/" onClick={() => setNavOpen(false)}>
          {t("publicNav")}
        </NavLink>
        <button className="btn" style={{ margin: "12px" }} onClick={logout}>
          {t("logout")}
        </button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
