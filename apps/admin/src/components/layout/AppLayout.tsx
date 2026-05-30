import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

// Authed shell: fixed sidebar + topbar, scrollable content region rendered via <Outlet/>.
export function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
