import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { AppLayout } from "./components/layout/AppLayout";
import { LoginPage } from "./routes/LoginPage";
import { DashboardPage } from "./routes/DashboardPage";
import { CommunityPage } from "./routes/CommunityPage";
import { SocialAnalyticsPage } from "./routes/SocialAnalyticsPage";
import { ModerationPage } from "./routes/ModerationPage";
import { StewardPage } from "./routes/StewardPage";
import { SettingsPage } from "./routes/SettingsPage";
import { HelpPage } from "./routes/HelpPage";
import { SpacesPage } from "./routes/SpacesPage";
import { NotFound } from "./routes/NotFound";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/spaces" element={<SpacesPage />} />
          <Route path="/social" element={<SocialAnalyticsPage />} />
          <Route path="/moderation" element={<ModerationPage />} />
          <Route path="/steward" element={<StewardPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/help" element={<HelpPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
