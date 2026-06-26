import React, { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import {
  LayoutDashboard, Users, Clock, Calendar, CheckCircle2, IndianRupee,
  Wallet, BarChart3, Shield, Activity, Settings, FileText, LogOut,
  ChevronRight, Layers, Search, X, Command, UserCheck,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────

type NavChildItem = {
  path: string;
  label: string;
};

type NavItemData = {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  badge?: number;
  children?: NavChildItem[];
};

type NavGroupData = {
  heading?: string;
  items: NavItemData[];
};

// ── Nav Data — same items & order as original HrLayout ────────────────────

const navGroups: NavGroupData[] = [
  {
    items: [
      { path: '/hr/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      {
        path: '/hr/employees',
        label: 'Employees',
        icon: Users,
        children: [
          { path: '/hr/employees', label: 'All Employees' },
          { path: '/hr/departments', label: 'Departments' },
          { path: '/hr/designations', label: 'Designations' },
          { path: '/hr/branches', label: 'Manage Branch' },
        ],
      },
      { path: '/hr/attendance', label: 'Attendance', icon: UserCheck },
    ],
  },
  {
    heading: 'HR Operations',
    items: [
      { path: '/hr/shifts', label: 'Manage Shift', icon: Clock },
      { path: '/hr/leave', label: 'Leave & Holiday', icon: Calendar },
      { path: '/hr/requests', label: 'Requests', icon: CheckCircle2 },
    ],
  },
  {
    heading: 'Payroll',
    items: [
      { path: '/hr/payroll', label: 'Payroll', icon: IndianRupee },
      { path: '/hr/settlement', label: 'Settlement', icon: Wallet },
      { path: '/hr/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { path: '/hr/user-management', label: 'User Management', icon: Shield },
      { path: '/hr/activity-logs', label: 'Activity Logs', icon: Activity },
      { path: '/hr/settings', label: 'Settings', icon: Settings },
      { path: '/hr/salary-slip', label: 'Salary Slip', icon: FileText },
    ],
  },
];

// ── Search Modal ───────────────────────────────────────────────────────────

function SearchModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm px-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-[#1a2a3a] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center px-4 border-b border-white/10">
          <Search className="w-[16px] h-[16px] text-white/40 mr-3 shrink-0" strokeWidth={1.5} />
          <input
            autoFocus
            className="flex-1 bg-transparent py-3.5 outline-none text-[13px] text-white placeholder:text-white/30"
            placeholder="Search pages, settings…"
          />
          <button
            onClick={onClose}
            className="ml-2 p-1 rounded-md text-white/30 hover:bg-white/5 hover:text-white/70 transition-colors"
          >
            <X className="w-[15px] h-[15px]" strokeWidth={1.5} />
          </button>
        </div>
        <div className="p-4 py-7 flex flex-col items-center justify-center">
          <Command className="w-5 h-5 text-white/15 mb-2" strokeWidth={1.5} />
          <p className="text-[12px] text-white/30 font-medium">Type to search pages…</p>
        </div>
      </div>
    </div>
  );
}

// ── Single Nav Row ─────────────────────────────────────────────────────────

function NavItem({
  item,
  currentPath,
  onClose,
  level = 0,
}: {
  item: NavItemData;
  currentPath: string;
  onClose: () => void;
  level?: number;
}) {
  const hasChildren = !!item.children;

  const isActive =
    !hasChildren &&
    (currentPath === item.path || currentPath.startsWith(item.path + '/'));

  const isParentActive =
    hasChildren &&
    item.children!.some(
      (c) => currentPath === c.path || currentPath.startsWith(c.path + '/')
    );

  const [isOpen, setIsOpen] = useState(isParentActive);

  const rowBase =
    'group flex items-center justify-between py-[7px] pr-2.5 rounded-[6px] cursor-pointer transition-all duration-200 select-none';
  const rowActive = 'bg-white/10 text-white font-medium';
  const rowIdle = 'text-white/60 hover:bg-white/[0.06] hover:text-white/90';
  const rowClasses = `${rowBase} ${isActive || isParentActive ? rowActive : rowIdle}`;
  const rowStyle = { paddingLeft: `${level * 12 + 10}px` };

  const rowInner = (
    <>
      <div className="flex items-center gap-2.5 min-w-0">
        <item.icon
          className={`w-4 h-4 shrink-0 transition-colors ${
            isActive || isParentActive
              ? 'text-cyan-400'
              : 'text-white/40 group-hover:text-white/70'
          }`}
          strokeWidth={1.5}
        />
        <span className="text-[13px] tracking-wide truncate">{item.label}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        {item.badge != null && (
          <span className="flex items-center justify-center min-w-[18px] h-4 px-1 text-[10px] font-bold rounded-full bg-cyan-500/20 text-cyan-400">
            {item.badge}
          </span>
        )}
        {hasChildren && (
          <ChevronRight
            className={`w-3 h-3 text-white/25 transition-transform duration-200 ${
              isOpen ? 'rotate-90' : ''
            }`}
            strokeWidth={2.5}
          />
        )}
      </div>
    </>
  );

  return (
    <div className="flex flex-col w-full">
      {hasChildren ? (
        <div className={rowClasses} style={rowStyle} onClick={() => setIsOpen(!isOpen)}>
          {rowInner}
        </div>
      ) : (
        <Link href={item.path} onClick={onClose}>
          <div className={rowClasses} style={rowStyle}>
            {rowInner}
          </div>
        </Link>
      )}

      {hasChildren && (
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
            isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden min-h-0 relative flex flex-col gap-0.5 mt-0.5">
            <div
              className="absolute top-0 bottom-0 border-l border-white/[0.08]"
              style={{ left: `${level * 12 + 19}px` }}
            />
            {item.children!.map((child) => {
              const childActive = currentPath === child.path;
              return (
                <Link key={child.path} href={child.path} onClick={onClose}>
                  <div
                    className={`flex items-center gap-2.5 py-[6px] pr-2.5 rounded-[6px] cursor-pointer text-[12.5px] tracking-wide transition-all select-none ${
                      childActive
                        ? 'text-white font-medium bg-white/[0.07]'
                        : 'text-white/40 hover:bg-white/[0.04] hover:text-white/70'
                    }`}
                    style={{ paddingLeft: `${(level + 1) * 12 + 10}px` }}
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        childActive ? 'bg-cyan-400' : 'bg-white/20'
                      }`}
                    />
                    <span className="truncate">{child.label}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Exported Sidebar ───────────────────────────────────────────────────────

export function HrSidebar({ onClose }: { onClose: () => void }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  return (
    <div className="relative flex flex-col h-full">
      {/* Brand Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shadow-sm shrink-0"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #06b6d4)' }}
          >
            <Layers className="w-4 h-4 text-white" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            {/* <p className="text-[10px] font-bold tracking-[0.3em] uppercase text-cyan-400/80 leading-none mb-0.5">
              HR Portal
            </p> */}
            <h1 className="text-[15px] font-black text-white leading-none">UKTextiles</h1>
          </div>
        </div>
        {/* Mobile close */}
        <button
          onClick={onClose}
          className="lg:hidden p-1 rounded-md text-white/30 hover:bg-white/[0.06] hover:text-white/70 transition-colors shrink-0"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* User Info */}
      <div className="px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black text-white shrink-0"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)' }}
          >
            {(user?.name ?? 'H').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-white truncate leading-none mb-0.5">
              {user?.name ?? 'HR Admin'}
            </p>
            <p className="text-[11px] text-white/40 leading-none">HR Manager</p>
          </div>
          <button
            onClick={() => setIsSearchOpen(true)}
            className="p-1.5 rounded-md text-white/30 hover:bg-white/[0.06] hover:text-white/60 transition-colors shrink-0"
            title="Search (⌘K)"
          >
            <Search className="w-[15px] h-[15px]" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-3 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] flex flex-col gap-4">
        {navGroups.map((group, idx) => (
          <div key={idx} className="flex flex-col gap-0.5">
            {group.heading && (
              <span className="px-2.5 mb-1 text-[10px] font-bold tracking-[0.15em] uppercase text-white/25">
                {group.heading}
              </span>
            )}
            {group.items.map((item) => (
              <NavItem
                key={item.path}
                item={item}
                currentPath={location}
                onClose={onClose}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Sign Out */}
      <div className="px-3 py-3 border-t border-white/[0.06]">
        <button
          onClick={logout}
          data-testid="button-logout"
          className="w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-[6px] text-white/40 hover:text-white hover:bg-white/[0.06] transition-all text-[13px] font-medium"
        >
          <LogOut className="w-4 h-4 shrink-0" strokeWidth={1.5} />
          <span className="tracking-wide">Sign Out</span>
        </button>
      </div>

      {/* Search Modal */}
      {isSearchOpen && <SearchModal onClose={() => setIsSearchOpen(false)} />}
    </div>
  );
}

export default HrSidebar;
