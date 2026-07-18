import { Navigate, Route, Routes } from "react-router-dom";
import { PublicHome } from "./pages/PublicHome";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicHome />} />
      {/* Legacy routes (bookmarks / muscle memory): everything lives on the home page now */}
      <Route path="/admin/*" element={<Navigate to="/" replace />} />
      <Route path="/app" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
