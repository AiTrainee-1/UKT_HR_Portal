import { useState } from "react";
import { Menu } from "lucide-react";
import { HrSidebar } from "@/components/ui/dashboard-sidebar";

export default function HrLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div
      className="flex h-screen"
      style={{
        background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 50%, #eef4fc 100%)",
        fontFamily: "'Hanken Grotesk', 'Inter', sans-serif",
      }}
    >
      {/* ── Sidebar ── */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 flex flex-col w-64 overflow-hidden
          transform transition-transform duration-300 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          lg:relative lg:translate-x-0
        `}
        style={{
          background: "#f6fafe",
          borderRight: "1px solid rgba(0,100,150,0.08)",
          boxShadow:
            "10px 0 30px rgba(0,100,150,0.08), 2px 0 8px rgba(255,255,255,0.9)",
        }}
      >
        <HrSidebar onClose={() => setMobileOpen(false)} />
      </aside>

      {/* ── Mobile overlay ── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          style={{ background: "rgba(0,60,100,0.2)", backdropFilter: "blur(4px)" }}
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <header
          className="flex items-center gap-3 px-4 py-3 lg:hidden"
          style={{
            background: "#f6fafe",
            borderBottom: "1px solid rgba(0,100,150,0.07)",
            boxShadow: "0 4px 16px rgba(0,100,150,0.06)",
          }}
        >
          <button
            onClick={() => setMobileOpen(true)}
            data-testid="button-menu"
            className="p-2 rounded-xl transition-all"
            style={{ color: "#006496" }}
          >
            <Menu size={20} strokeWidth={2} />
          </button>
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 1536 1024" className="h-7 w-auto" aria-hidden="true">
              <defs>
                <mask id="ukt-topbar-ring-gap">
                  <rect x="0" y="0" width="1536" height="1024" fill="white" />
                  <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
                </mask>
              </defs>
              <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ukt-topbar-ring-gap)" />
              <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
              <path
                fill="#FFFFFF"
                d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
              />
            </svg>
            <span className="font-black text-base tracking-tight" style={{ color: "#006496" }}>
              UKTextiles
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
