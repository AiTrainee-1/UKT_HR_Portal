import React, { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '@/contexts/AuthContext';
import { useListLeaveRequests, useListPermissions } from '@/lib/api-client';
import {
  LayoutDashboard, Users, Clock, Calendar, CheckCircle2, IndianRupee,
  Wallet, BarChart3, Shield, Activity, Settings, FileText, LogOut,
  ChevronRight, Search, X, Command, UserCheck,
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

// ── Nav Data ───────────────────────────────────────────────────────────────

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
      { path: '/hr/salary-slip', label: 'Salary Slip', icon: FileText },
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
    ],
  },
];

// ── UKT Logo SVG ───────────────────────────────────────────────────────────

function UKTLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1536 1024"
      className={className}
      aria-label="UKTextiles Logo"
    >
      <defs>
        <mask id="ukt-sb-ring-gap">
          <rect x="0" y="0" width="1536" height="1024" fill="white" />
          <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
        </mask>
      </defs>
      <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ukt-sb-ring-gap)" />
      <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
      <path
        fill="#FFFFFF"
        d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
      />
    </svg>
  );
}

// ── Search Modal ───────────────────────────────────────────────────────────

function SearchModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-[12vh] bg-[#006496]/10 backdrop-blur-sm px-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative w-full max-w-sm rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        style={{
          background: '#ffffff',
          boxShadow: '12px 12px 24px rgba(0,100,150,0.15), -6px -6px 18px rgba(255,255,255,0.9), inset 3px 3px 6px rgba(255,255,255,0.6)',
        }}
      >
        <div
          className="flex items-center px-4 border-b"
          style={{ borderColor: 'rgba(0,100,150,0.08)' }}
        >
          <Search className="w-4 h-4 text-[#006496]/50 mr-3 shrink-0" strokeWidth={1.5} />
          <input
            autoFocus
            className="flex-1 bg-transparent py-3.5 outline-none text-[13px] text-[#1a3a4a] placeholder:text-[#006496]/30"
            placeholder="Search pages, settings…"
          />
          <button
            onClick={onClose}
            className="ml-2 p-1 rounded-lg text-[#006496]/30 hover:bg-[#006496]/05 hover:text-[#006496]/70 transition-colors"
          >
            <X className="w-[15px] h-[15px]" strokeWidth={1.5} />
          </button>
        </div>
        <div className="p-4 py-7 flex flex-col items-center justify-center">
          <Command className="w-5 h-5 text-[#006496]/20 mb-2" strokeWidth={1.5} />
          <p className="text-[12px] text-[#006496]/40 font-medium">Type to search pages…</p>
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
    'group flex items-center justify-between py-[8px] pr-3 rounded-xl cursor-pointer transition-all duration-200 select-none';

  const rowActive = 'clay-nav-active';
  const rowIdle =
    'text-[#006496]/70 hover:text-[#006496] hover:translate-x-1';

  const rowClasses = `${rowBase} ${isActive || isParentActive ? rowActive : rowIdle}`;
  const rowStyle = { paddingLeft: `${level * 12 + 10}px` };

  const rowInner = (
    <>
      <div className="flex items-center gap-2.5 min-w-0">
        <item.icon
          className={`w-4 h-4 shrink-0 transition-colors ${
            isActive || isParentActive
              ? 'text-white'
              : 'text-[#006496]/50 group-hover:text-[#006496]'
          }`}
          strokeWidth={1.8}
        />
        <span
          className={`text-[13px] font-medium truncate ${
            isActive || isParentActive ? 'text-white' : ''
          }`}
        >
          {item.label}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        {item.badge != null && item.badge > 0 && (
          <span className="relative flex items-center justify-center">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-50" />
            <span
              className="relative flex items-center justify-center min-w-[18px] h-4 px-1 text-[10px] font-bold rounded-full text-white"
              style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
            >
              {item.badge}
            </span>
          </span>
        )}
        {hasChildren && (
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform duration-200 ${
              isActive || isParentActive ? 'text-white/70' : 'text-[#006496]/30'
            } ${isOpen ? 'rotate-90' : ''}`}
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
          <div className="overflow-hidden min-h-0 relative flex flex-col gap-0.5 mt-1">
            <div
              className="absolute top-0 bottom-0 border-l-2"
              style={{
                left: `${level * 12 + 19}px`,
                borderColor: 'rgba(0,100,150,0.12)',
              }}
            />
            {item.children!.map((child) => {
              const childActive = currentPath === child.path;
              return (
                <Link key={child.path} href={child.path} onClick={onClose}>
                  <div
                    className={`flex items-center gap-2.5 py-[6px] pr-3 rounded-xl cursor-pointer text-[12.5px] transition-all select-none ${
                      childActive
                        ? 'font-semibold clay-nav-active'
                        : 'text-[#006496]/60 hover:text-[#006496] hover:bg-[#006496]/05 hover:translate-x-1'
                    }`}
                    style={{ paddingLeft: `${(level + 1) * 12 + 10}px` }}
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        childActive ? 'bg-white' : 'bg-[#006496]/25'
                      }`}
                    />
                    <span className={childActive ? 'text-white' : ''}>{child.label}</span>
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

  const { data: leaveData } = useListLeaveRequests(undefined, { query: { refetchInterval: 30_000 } } as any);
  const { data: permData }  = useListPermissions(undefined, { refetchInterval: 30_000 } as any);
  const pendingCount =
    ((leaveData ?? []).filter((l: any) => l.status === 'pending').length) +
    ((permData  ?? []).filter((p: any) => p.status === 'pending').length);

  const initials = (user?.name ?? 'H')
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="relative flex flex-col h-full" style={{ fontFamily: "'Hanken Grotesk', 'Inter', sans-serif" }}>

      {/* ── Brand Header ── */}
      <div
        className="flex items-center justify-between px-4 py-4"
        style={{ borderBottom: '1px solid rgba(0,100,150,0.08)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <UKTLogo className="h-9 w-auto shrink-0" />
          <div className="min-w-0">
            <h1
              className="text-[15px] font-black leading-none tracking-tight"
              style={{ color: '#006496' }}
            >
              UKTextiles
            </h1>
            <p className="text-[10px] font-semibold tracking-widest uppercase leading-none mt-0.5" style={{ color: '#006496', opacity: 0.45 }}>
              HR Portal
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="lg:hidden p-1.5 rounded-lg transition-colors shrink-0"
          style={{ color: 'rgba(0,100,150,0.4)' }}
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </div>

      {/* ── Search Bar ── */}
      <div className="px-3 py-2.5" style={{ borderBottom: '1px solid rgba(0,100,150,0.06)' }}>
        <button
          onClick={() => setIsSearchOpen(true)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all text-left"
          style={{
            background: '#f0f4f8',
            boxShadow: 'inset 3px 3px 7px rgba(0,100,150,0.08), inset -3px -3px 7px rgba(255,255,255,0.9)',
            color: 'rgba(0,100,150,0.4)',
          }}
        >
          <Search className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
          <span className="text-[12px] font-medium flex-1">Search pages…</span>
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
            style={{ background: 'rgba(0,100,150,0.08)', color: 'rgba(0,100,150,0.4)' }}
          >
            ⌘K
          </span>
        </button>
      </div>

      {/* ── Navigation ── */}
      <nav
        className="flex-1 overflow-y-auto py-3 px-2.5 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] flex flex-col gap-0.5"
      >
        {navGroups.map((group, idx) => (
          <div key={idx} className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavItem
                key={item.path}
                item={
                  item.path === '/hr/requests'
                    ? { ...item, badge: pendingCount || undefined }
                    : item
                }
                currentPath={location}
                onClose={onClose}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* ── Sign Out ── */}
      <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(0,100,150,0.08)' }}>
        <button
          onClick={logout}
          data-testid="button-logout"
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all duration-200 text-[13px] font-medium hover:translate-x-1"
          style={{ color: 'rgba(0,100,150,0.55)' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = '#c0392b';
            (e.currentTarget as HTMLElement).style.background = 'rgba(192,57,43,0.06)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'rgba(0,100,150,0.55)';
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <LogOut className="w-4 h-4 shrink-0" strokeWidth={1.8} />
          <span>Sign Out</span>
        </button>
      </div>

      {/* ── Search Modal ── */}
      {isSearchOpen && <SearchModal onClose={() => setIsSearchOpen(false)} />}
    </div>
  );
}

export default HrSidebar;
