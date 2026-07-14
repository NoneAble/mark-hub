import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../i18n";
import { currentTheme, initThemeFromStorage, toggleTheme } from "../lib/theme";
import { LogoMark } from "./ui";

type NavItem = { path: string; labelKey: string; icon: string; end?: boolean };

const MAIN_NAV: NavItem[] = [
  { path: "/app", labelKey: "workbench", icon: "⌂", end: true },
  { path: "/app/cleaner", labelKey: "cleaner", icon: "◎" },
  { path: "/app/compare", labelKey: "compare", icon: "⇔" },
  { path: "/app/ai", labelKey: "ai", icon: "✦" },
  { path: "/app/boards", labelKey: "boards", icon: "▦" },
  { path: "/app/discover", labelKey: "discover", icon: "◈" },
  { path: "/app/settings", labelKey: "settings", icon: "⚙" },
];

const ADMIN_NAV: NavItem[] = [
  { path: "/admin", labelKey: "overview", icon: "▣", end: true },
  { path: "/admin/bookmarks", labelKey: "bookmarks", icon: "★" },
  { path: "/admin/folders", labelKey: "folders", icon: "⊞" },
  { path: "/admin/tags", labelKey: "tags", icon: "#" },
  { path: "/admin/backup", labelKey: "backup", icon: "⇓" },
  { path: "/admin/ai", labelKey: "ai", icon: "✦" },
  { path: "/admin/mcp", labelKey: "mcp", icon: "🔌" },
  { path: "/admin/settings", labelKey: "settings", icon: "⚙" },
  { path: "/admin/account", labelKey: "account", icon: "☺" },
  { path: "/admin/about", labelKey: "about", icon: "ⓘ" },
];

export function WorkbenchShell() {
  const { t, lang, toggleLang } = useI18n();
  const { logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    initThemeFromStorage();
    setTheme(currentTheme());
  }, []);

  const allNav = [...MAIN_NAV, ...ADMIN_NAV];

  function onToggleTheme() {
    setTheme(toggleTheme());
  }

  function NavItems({ items }: { items: NavItem[] }) {
    return (
      <div className="sidebar-nav">
        {items.map((it) => (
          <NavLink
            key={it.path}
            to={it.path}
            end={it.end}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            <span className="nav-ico">{it.icon}</span>
            {t(it.labelKey as any)}
          </NavLink>
        ))}
      </div>
    );
  }

  return (
    <div className="layout-shell">
      {/* Prototype narrow: sticky top bar + horizontal nav chips */}
      <header className="mobile-nav-bar">
        <div className="mobile-nav-top">
          <LogoMark size={24} />
          <strong style={{ fontSize: 14 }}>{t("appName")}</strong>
          <div className="mobile-nav-actions">
            <button type="button" className="btn topbar-btn" onClick={onToggleTheme} aria-label="Theme">
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button type="button" className="btn topbar-btn" onClick={toggleLang} aria-label="Language">
              {lang === "zh" ? "EN" : "中"}
            </button>
            <button type="button" className="btn topbar-btn" onClick={() => nav("/")} aria-label={t("viewSite")}>
              ↗
            </button>
            <button type="button" className="btn topbar-btn" onClick={logout} aria-label={t("logout")}>
              ⎋
            </button>
          </div>
        </div>
        <nav className="mobile-nav-scroll" aria-label="Main">
          {allNav.map((it) => {
            const active = it.end
              ? loc.pathname === it.path
              : loc.pathname === it.path || loc.pathname.startsWith(it.path + "/");
            return (
              <button
                key={it.path}
                type="button"
                className={`chip${active ? " active" : ""}`}
                onClick={() => nav(it.path)}
              >
                {it.icon} {t(it.labelKey as any)}
              </button>
            );
          })}
        </nav>
      </header>

      <aside className="sidebar">
        <div className="sidebar-brand">
          <LogoMark size={26} />
          <span>{t("appName")}</span>
        </div>
        <NavItems items={MAIN_NAV} />
        <div className="sidebar-group">{t("adminGroup")}</div>
        <NavItems items={ADMIN_NAV} />
        <div className="sidebar-foot">
          <div className="sidebar-nav">
            <button type="button" className="nav-item" onClick={() => nav("/")}>
              <span className="nav-ico">↗</span>
              {t("viewSite")}
            </button>
          </div>
          <div className="sidebar-foot-btns">
            <button type="button" className="btn" onClick={onToggleTheme}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button type="button" className="btn" onClick={toggleLang}>
              {lang === "zh" ? "EN" : "中文"}
            </button>
          </div>
          <div className="sidebar-nav">
            <button type="button" className="nav-item" onClick={logout}>
              <span className="nav-ico">⎋</span>
              {t("logout")}
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
