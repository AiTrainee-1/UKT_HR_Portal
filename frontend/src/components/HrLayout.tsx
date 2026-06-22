import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  LayoutDashboard, Users, Clock, Calendar, CheckCircle2, IndianRupee,
  Wallet, BarChart3, Shield, Activity, Settings, FileText, LogOut,
  Menu, X, ChevronRight, ChevronDown, Building2, Briefcase, Bell,
  Layers,
} from "lucide-react";
import { useState } from "react";

type NavItem = {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  badge?: number;
  children?: { path: string; label: string }[];
};

const navItems: NavItem[] = [
  { path: "/hr/dashboard", label: "Dashboard", icon: LayoutDashboard },
  {
    path: "/hr/employees",
    label: "Employees",
    icon: Users,
    children: [
      { path: "/hr/employees", label: "All Employees" },
      { path: "/hr/departments", label: "Departments" },
      { path: "/hr/designations", label: "Designations" },
      { path: "/hr/branches", label: "Manage Branch" },
    ],
  },
  { path: "/hr/shifts", label: "Manage Shift", icon: Clock },
  { path: "/hr/leave", label: "Leave & Holiday", icon: Calendar },
  { path: "/hr/requests", label: "Approved Requests", icon: CheckCircle2 },
  { path: "/hr/payroll", label: "Payroll", icon: IndianRupee },
  { path: "/hr/settlement", label: "Settlement", icon: Wallet },
  { path: "/hr/reports", label: "Reports", icon: BarChart3 },
  { path: "/hr/user-management", label: "User Management", icon: Shield },
  { path: "/hr/activity-logs", label: "Activity Logs", icon: Activity },
  { path: "/hr/settings", label: "Settings", icon: Settings },
  { path: "/hr/salary-slip", label: "Salary Slip", icon: FileText },
];

function NavGroup({ item, currentPath, onClose }: {
  item: NavItem;
  currentPath: string;
  onClose: () => void;
}) {
  const isActive = currentPath === item.path || currentPath.startsWith(item.path + "/") ||
    item.children?.some(c => currentPath === c.path || currentPath.startsWith(c.path));
  const hasChildren = item.children && item.children.length > 0;
  const [open, setOpen] = useState(isActive);
  const Icon = item.icon;

  if (!hasChildren) {
    return (
      <Link href={item.path} onClick={onClose}>
        <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-all duration-150 ${
          isActive
            ? "bg-white/10 text-white"
            : "text-white/60 hover:bg-white/5 hover:text-white/90"
        }`}>
          <Icon size={17} />
          <span className="text-sm font-medium flex-1">{item.label}</span>
          {item.badge ? (
            <Badge className="bg-cyan-500 text-white text-xs px-1.5 py-0 h-4 min-w-4">{item.badge}</Badge>
          ) : isActive ? (
            <ChevronRight size={12} className="opacity-60" />
          ) : null}
        </div>
      </Link>
    );
  }

  return (
    <div>
      <div
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-all duration-150 ${
          isActive ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white/90"
        }`}
      >
        <Icon size={17} />
        <span className="text-sm font-medium flex-1">{item.label}</span>
        <ChevronDown size={13} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </div>
      {open && (
        <div className="ml-3 pl-3 border-l border-white/10 mb-1">
          {item.children!.map(child => (
            <Link key={child.path} href={child.path} onClick={onClose}>
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-0.5 cursor-pointer text-sm transition-all ${
                currentPath === child.path
                  ? "bg-white/10 text-white font-medium"
                  : "text-white/50 hover:bg-white/5 hover:text-white/80"
              }`}>
                <div className="w-1 h-1 rounded-full bg-current opacity-50" />
                {child.label}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HrLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen" style={{ background: "#f0f4f8" }}>
      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 flex flex-col w-64 overflow-hidden
        transform transition-transform duration-200
        ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        lg:relative lg:translate-x-0
      `} style={{
        background: "linear-gradient(180deg, #0f1923 0%, #1a2a3a 100%)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}>
        {/* Brand */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #3b82f6, #06b6d4)" }}>
              <Layers size={16} className="text-white" />
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-[0.3em] uppercase text-cyan-400/80">HR Portal</p>
              <h1 className="text-base font-black text-white leading-none">UKTextiles</h1>
            </div>
          </div>
          <button onClick={() => setMobileOpen(false)} className="lg:hidden text-white/40 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* User info */}
        <div className="px-5 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
              style={{ background: "linear-gradient(135deg, #3b82f6, #6366f1)" }}>
              {(user?.name ?? "H").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">{user?.name ?? "HR Admin"}</p>
              <p className="text-xs text-white/40">HR Manager</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3 px-3 scrollbar-thin">
          {navItems.map(item => (
            <NavGroup
              key={item.path}
              item={item}
              currentPath={location}
              onClose={() => setMobileOpen(false)}
            />
          ))}
        </nav>

        {/* Logout */}
        <div className="px-3 py-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <button
            onClick={logout}
            data-testid="button-logout"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-all text-sm font-medium"
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Overlay (mobile) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-4 px-4 py-3 lg:hidden bg-white border-b">
          <button onClick={() => setMobileOpen(true)} data-testid="button-menu">
            <Menu size={20} />
          </button>
          <h1 className="font-bold text-lg text-gray-900">UKTextiles HR</h1>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
