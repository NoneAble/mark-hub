import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { PublicHome } from "./pages/PublicHome";
import { LoginPage } from "./pages/LoginPage";
import { SharePage } from "./pages/SharePage";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminBookmarks } from "./pages/admin/Bookmarks";
import { AdminFolders } from "./pages/admin/Folders";
import { AdminTags } from "./pages/admin/Tags";
import { AdminSettings } from "./pages/admin/Settings";
import { AppLayout } from "./pages/app/AppLayout";
import { Dashboard } from "./pages/app/Dashboard";

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
        <Route index element={<Navigate to="/admin/bookmarks" replace />} />
        <Route path="bookmarks" element={<AdminBookmarks />} />
        <Route path="folders" element={<AdminFolders />} />
        <Route path="tags" element={<AdminTags />} />
        <Route path="settings" element={<AdminSettings />} />
        {/* Legacy routes → merged settings page */}
        <Route path="backup" element={<AdminSettings initialTab="backup" />} />
        <Route path="account" element={<AdminSettings initialTab="account" />} />
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
