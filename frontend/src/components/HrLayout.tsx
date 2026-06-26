import { useState } from "react";
import { Menu } from "lucide-react";
import { HrSidebar } from "@/components/ui/dashboard-sidebar";

export default function HrLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen" style={{ background: "#f0f4f8" }}>
      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 flex flex-col w-64 overflow-hidden
          transform transition-transform duration-200
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          lg:relative lg:translate-x-0
        `}
        style={{
          background: "linear-gradient(180deg, #0f1923 0%, #1a2a3a 100%)",
          borderRight: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <HrSidebar onClose={() => setMobileOpen(false)} />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-4 px-4 py-3 lg:hidden bg-white border-b">
          <button onClick={() => setMobileOpen(true)} data-testid="button-menu">
            <Menu size={20} />
          </button>
          <h1 className="font-bold text-lg text-gray-900">UKTextiles HR</h1>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
