import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { PublicHome } from "./pages/PublicHome";
import { LoginPage } from "./pages/LoginPage";
import { SharePage } from "./pages/SharePage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminOverview } from "./pages/admin/Overview";
import { AdminBookmarks } from "./pages/admin/Bookmarks";
import { AdminFolders } from "./pages/admin/Folders";
import { AdminTags } from "./pages/admin/Tags";
import { AdminBackup } from "./pages/admin/Backup";
import { AdminAI } from "./pages/admin/AI";
import { AdminSettings } from "./pages/admin/Settings";
import { AdminAccount } from "./pages/admin/Account";
import { AdminAbout } from "./pages/admin/About";
import { AdminMCP } from "./pages/admin/MCP";
import { AppLayout } from "./pages/app/AppLayout";
import { Dashboard } from "./pages/app/Dashboard";
import { CleanerPage } from "./pages/app/Cleaner";
import { ComparePage } from "./pages/app/Compare";
import { AIChatPage } from "./pages/app/AIChat";
import { BoardsPage } from "./pages/app/Boards";
import { DiscoverPage } from "./pages/app/Discover";
import { AppSettingsPage } from "./pages/app/AppSettings";

function RequireAuth({
  children,
  allowPasswordChange = false,
}: {
  children: React.ReactNode;
  allowPasswordChange?: boolean;
}) {
  const { token, user } = useAuth();
  if (!token) return <Navigate to="/admin/login" replace />;
  if (user?.must_change_password && !allowPasswordChange) {
    return <Navigate to="/admin/account?force=1" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicHome />} />
      <Route path="/s/:token" element={<SharePage />} />
      <Route path="/admin/login" element={<LoginPage />} />
      <Route
        path="/admin"
        element={
          <RequireAuth allowPasswordChange>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<AdminOverview />} />
        <Route path="bookmarks" element={<AdminBookmarks />} />
        <Route path="folders" element={<AdminFolders />} />
        <Route path="tags" element={<AdminTags />} />
        <Route path="backup" element={<AdminBackup />} />
        <Route path="ai" element={<AdminAI />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="account" element={<AdminAccount />} />
        <Route path="about" element={<AdminAbout />} />
        <Route path="mcp" element={<AdminMCP />} />
      </Route>
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="cleaner" element={<CleanerPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="ai" element={<AIChatPage />} />
        <Route path="boards" element={<BoardsPage />} />
        <Route path="discover" element={<DiscoverPage />} />
        <Route path="settings" element={<AppSettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
