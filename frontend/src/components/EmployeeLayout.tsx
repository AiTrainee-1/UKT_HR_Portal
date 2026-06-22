import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, User, IndianRupee, Calendar, Bell, LogOut, Menu, X, ChevronRight } from "lucide-react";
import { useState } from "react";

const navItems = [
  { path: "/employee/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/employee/profile", label: "My Profile", icon: User },
  { path: "/employee/salary", label: "Salary", icon: IndianRupee },
  { path: "/employee/leave", label: "Leave", icon: Calendar },
  { path: "/employee/notifications", label: "Messages", icon: Bell },
];

export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background">
      <aside className={`
        fixed inset-y-0 left-0 z-50 flex flex-col w-64 bg-sidebar text-sidebar-foreground
        transform transition-transform duration-200
        ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        lg:relative lg:translate-x-0
      `}>
        <div className="flex items-center justify-between px-6 py-5 border-b border-sidebar-border">
          <div>
            <p className="text-xs font-semibold tracking-widest uppercase text-sidebar-primary opacity-80">UK</p>
            <h1 className="text-xl font-bold text-sidebar-foreground leading-tight">Textile</h1>
          </div>
          <button onClick={() => setMobileOpen(false)} className="lg:hidden text-sidebar-foreground">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-4 border-b border-sidebar-border">
          <p className="text-xs text-sidebar-foreground/50 uppercase tracking-wider">Employee</p>
          <p className="text-sm font-semibold text-sidebar-foreground truncate">{user?.name ?? "Employee"}</p>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = location === path;
            return (
              <Link key={path} href={path} onClick={() => setMobileOpen(false)}>
                <div data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg mb-1 cursor-pointer transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  }`}
                >
                  <Icon size={18} />
                  <span className="text-sm font-medium">{label}</span>
                  {active && <ChevronRight size={14} className="ml-auto" />}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="px-3 py-4 border-t border-sidebar-border">
          <Button
            variant="ghost"
            onClick={logout}
            data-testid="button-logout"
            className="w-full justify-start gap-3 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <LogOut size={18} />
            <span className="text-sm">Sign Out</span>
          </Button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="flex items-center gap-4 px-4 py-3 border-b bg-card lg:hidden">
          <button onClick={() => setMobileOpen(true)} data-testid="button-menu">
            <Menu size={20} />
          </button>
          <h1 className="font-bold text-lg">UK Textile</h1>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
