import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeftRight, ChevronRight, LogOut, Menu, PanelLeftClose, Sparkles, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UKTLogo } from "@/components/ui/dashboard-sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { toggleAssistant, useAssistantState } from "@/lib/md/assistant-store";
import { hasHrAccess } from "@/lib/md/access";
import { hrToMd } from "@/lib/md/embed";
import { MD_PALETTE } from "@/lib/md/theme";
import { cn } from "@/lib/utils";
import { useMdHods } from "@/pages/md/approvals/api";
import { hodLabel, hodPath } from "@/pages/md/approvals/logic";
import type { Hod } from "@/pages/md/approvals/types";
import { MD_NAV_GROUPS, type MdNavItem } from "./md-nav";

/** @deprecated The MD portal no longer has a gold: its colours are wine, midnight indigo and sand (md-portal.md section 11).
 *  Kept, with the wine, because other files still import it; use `text-md-wine` / `bg-md-wine` or `var(--md-wine)`. */
export const MD_GOLD: string = MD_PALETTE.wine;
/** @deprecated See MD_GOLD: a wine gradient now. Prefer `md-btn md-btn-primary` or `.md-icon-tile-solid` for a wine surface. */
export const MD_GOLD_GRADIENT = "linear-gradient(135deg, var(--md-wine-700) 0%, var(--md-wine-500) 100%)";

const isActivePath = (current: string, path: string) => {
  const now = current.toLowerCase();
  const own = path.toLowerCase();
  return now === own || now.startsWith(`${own}/`);
};

/** A small midnight-indigo glass label beside a rail control (the rail is too narrow for words). */
function Tip({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="md-shell-tip">
        {label}
        {hint && <span className="ml-2 opacity-70">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function ExpandedItem({ item, current, onClose }: { item: MdNavItem; current: string; onClose: () => void }) {
  const active = isActivePath(current, item.path);
  return (
    <Link
      href={item.path}
      onClick={onClose}
      data-testid={`md-nav-${item.id}`}
      aria-current={active ? "page" : undefined}
      className="md-shell-nav"
    >
      <item.icon className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
      <span className="truncate">{item.navLabel ?? item.title}</span>
    </Link>
  );
}

/** Whether the MD last opened or closed the heads under "HOD Approvals" (null: never chose). Kept in this browser, because
 *  every page mounts a new sidebar; a blocked storage just means the default below. */
const HODS_OPEN_KEY = "md-nav-hods-open";

function readHodsOpen(): boolean | null {
  try {
    const value = localStorage.getItem(HODS_OPEN_KEY);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function writeHodsOpen(open: boolean) {
  try {
    localStorage.setItem(HODS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // storage blocked: the choice lasts until the next page
  }
}

/** "HOD Approvals" in the open sidebar, opening and shutting like the HR portal's groups: the row shows or hides the
 *  Department Heads of the MD department (a small arrow that turns down when open) and each head opens their own tab
 *  ("HOD – Suresh Raj" with the count of requests waiting for them, a grey 0 when none). The row carries the total
 *  waiting. Until the MD chooses, the heads are shown on the HOD Approvals page and hidden elsewhere; the choice is
 *  remembered. They come from User Management (GET /api/md/approvals/hods): a head added or removed there appears or goes
 *  by itself. With no head at all, the row simply opens the page (which explains how to add one). */
function ApprovalsItem({ item, current, onClose }: { item: MdNavItem; current: string; onClose: () => void }) {
  const { data } = useMdHods();
  const hods = data?.hods ?? [];
  const onPage = isActivePath(current, item.path);
  const [choice, setChoice] = useState<boolean | null>(readHodsOpen);
  const open = hods.length > 0 && (choice ?? onPage);
  const waiting = hods.reduce((sum, h) => sum + h.pending.total, 0);
  const listId = useId();
  const label = item.navLabel ?? item.title;

  if (hods.length === 0) {
    return (
      <Link
        href={item.path}
        onClick={onClose}
        data-testid={`md-nav-${item.id}`}
        aria-current={onPage ? "page" : undefined}
        className="md-shell-nav"
      >
        <item.icon className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Link>
    );
  }

  const toggle = () => {
    const next = !open;
    setChoice(next);
    writeHodsOpen(next);
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={listId}
        aria-current={onPage ? "page" : undefined}
        title={open ? "Hide the Department Heads" : "Show the Department Heads"}
        data-testid={`md-nav-${item.id}`}
        className="md-shell-nav w-full text-left"
      >
        <item.icon className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {waiting > 0 && (
          <span className="md-shell-count" aria-label={`${waiting} waiting`} data-testid="md-nav-approvals-waiting">
            {waiting > 99 ? "99+" : waiting}
          </span>
        )}
        <ChevronRight
          className={cn("md-shell-nav-chevron", open && "rotate-90")}
          strokeWidth={2.5}
          aria-hidden="true"
          data-testid="md-nav-approvals-chevron"
        />
      </button>
      <div id={listId} className="md-shell-subnav-wrap" data-open={open} data-testid="md-nav-approvals-group">
        <div className="min-h-0 overflow-hidden">
          <HodSubNav hods={hods} current={current} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

function HodSubNav({ hods, current, onClose }: { hods: Hod[]; current: string; onClose: () => void }) {
  const here = current.toLowerCase().replace(/\/+$/, "");
  return (
    <ul className="md-shell-subnav-list" aria-label="Department Heads" data-testid="md-nav-approvals-hods">
      {hods.map((hod) => {
        const path = hodPath(hod.id);
        const active = here === path;
        const n = hod.pending.total;
        return (
          <li key={hod.id}>
            <Link
              href={path}
              onClick={onClose}
              aria-current={active ? "location" : undefined}
              data-testid={`md-nav-approvals-hod-${hod.id}`}
              className="md-shell-subnav"
              title={`${hodLabel(hod)}: ${n} waiting`}
            >
              <span className="md-shell-subnav-dot" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words leading-snug">{hodLabel(hod)}</span>
              <span className={cn("md-shell-count", n === 0 && "md-shell-count-zero")} aria-label={`${n} waiting`}>
                {n > 99 ? "99+" : n}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** On the collapsed rail the heads have no room: the HOD Approvals icon carries a dot when something waits for them. */
function useApprovalsWaiting(): number {
  const { data } = useMdHods();
  return (data?.hods ?? []).reduce((sum, h) => sum + h.pending.total, 0);
}

function RailItem({ item, current, onClose }: { item: MdNavItem; current: string; onClose: () => void }) {
  const active = isActivePath(current, item.path);
  const waiting = useApprovalsWaiting();
  const dot = item.id === "approvals" && waiting > 0;
  return (
    <Tip label={item.title} hint={dot ? `${waiting} waiting` : undefined}>
      <Link
        href={item.path}
        onClick={onClose}
        aria-label={dot ? `${item.title}, ${waiting} waiting` : item.title}
        aria-current={active ? "page" : undefined}
        data-testid={`md-nav-${item.id}`}
        className="md-shell-nav md-shell-nav-rail"
      >
        <item.icon className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
        {dot && <span className="md-shell-rail-dot" aria-hidden="true" />}
      </Link>
    </Tip>
  );
}

/** The MD portal's navigation: a glass rail on sand and vanilla with the company mark, the assistant's entry point, the pages
 *  in groups (the page you are on is a wine glass pill), and the Managing Director's identity card with a quiet sign-out.
 *  Collapses to an icon rail on desktop (Ctrl+B), is a drawer on small screens. */
export default function MdSidebar({
  onClose,
  collapsed = false,
  onToggleCollapse,
}: {
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  // Inside an MD copy of an HR page the router shows /hr/... addresses (lib/md/embed.ts): the sidebar compares /md/... ones
  const location = hrToMd(useLocation()[0]);
  const { user, logout } = useAuth();
  const { open: assistantOpen } = useAssistantState();
  const { data: settings } = usePayrollSettings();
  const companyName = settings?.companyName || "UKTextiles";
  const companyLogo = settings?.companyLogo;

  const hrAccess = hasHrAccess(user);
  const name = user?.name || "Managing Director";
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // The list is longer than a short screen, and every page remounts this rail: bring the page you are on into view
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    const above = current.getBoundingClientRect().top - nav.getBoundingClientRect().top;
    const room = nav.clientHeight - current.offsetHeight;
    if (above < 0 || above > room) nav.scrollTop += above - room / 2;
  }, [location, collapsed]);

  // the company mark on a white glass tile; the collapsed rail (68 px) gets a smaller one
  const logo = (
    <span className="md-shell-logo">
      {companyLogo ? (
        <img
          src={companyLogo}
          alt={companyName}
          className={cn("rounded-full object-contain", collapsed ? "h-6 w-6" : "h-7 w-7")}
        />
      ) : (
        <UKTLogo className={cn("w-auto", collapsed ? "h-6" : "h-7")} />
      )}
    </span>
  );

  const toggle = onToggleCollapse && (
    <div className="hidden lg:block">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            data-testid="button-sidebar-toggle"
            className={
              collapsed ? "md-btn md-btn-soft md-btn-icon md-shell-rail-toggle" : "md-btn md-btn-ghost md-btn-icon"
            }
          >
            {collapsed ? (
              <Menu size={18} strokeWidth={2} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side={collapsed ? "right" : "bottom"} sideOffset={12} className="md-shell-tip">
          {collapsed ? "Expand sidebar" : "Collapse sidebar"} <span className="ml-1 opacity-70">Ctrl+B</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <TooltipProvider delayDuration={120}>
      <div className="relative flex h-full flex-col" style={{ fontFamily: "'Hanken Grotesk', 'Inter', sans-serif" }}>
        {/* Brand */}
        {collapsed ? (
          // the collapsed rail follows the HR portal's: the round toggle alone at the top (the logo is for the open rail)
          <div className="flex items-center justify-center border-b border-md-line px-[10px] py-3">{toggle}</div>
        ) : (
          <div className="flex items-center gap-3 px-4 pb-3 pt-4">
            {logo}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-black leading-none tracking-tight text-md-wine">
                {companyName}
              </h1>
              <p className="md-shell-overline mt-1.5 flex items-center gap-1.5 text-md-ink-soft">
                <span className="h-1.5 w-1.5 rounded-full bg-md-wine" aria-hidden="true" />
                MD Portal
              </p>
            </div>
            <div className="lg:hidden">
              <button
                onClick={onClose}
                className="md-btn md-btn-ghost md-btn-icon"
                aria-label="Close menu"
                type="button"
              >
                <X size={18} strokeWidth={1.9} aria-hidden="true" />
              </button>
            </div>
            {toggle}
          </div>
        )}

        {/* Ask AI */}
        <div className={collapsed ? "flex justify-center border-b border-md-line px-[10px] py-2.5" : "px-3 pb-3"}>
          {collapsed ? (
            <Tip label="AI assistant" hint="Ctrl+J">
              <button
                type="button"
                onClick={toggleAssistant}
                aria-label="AI assistant"
                aria-pressed={assistantOpen}
                data-testid="md-ask-ai"
                className="md-btn md-btn-soft md-shell-ask-rail"
              >
                <Sparkles className="h-[18px] w-[18px] text-md-wine" strokeWidth={2} aria-hidden="true" />
              </button>
            </Tip>
          ) : (
            <button
              type="button"
              onClick={toggleAssistant}
              aria-pressed={assistantOpen}
              data-testid="md-ask-ai"
              className="md-btn md-btn-ink md-shell-ask-ai"
            >
              <span className="md-shell-spark">
                <Sparkles size={15} strokeWidth={2.2} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 truncate font-extrabold">Ask the AI assistant</span>
              <kbd className="md-shell-kbd">Ctrl J</kbd>
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav
          ref={navRef}
          aria-label="MD portal"
          className={
            collapsed
              ? "flex flex-1 flex-col items-center gap-3 overflow-y-auto px-[10px] py-3"
              : "flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-2"
          }
        >
          {MD_NAV_GROUPS.map((group, index) => (
            <div
              key={group.heading}
              className={
                collapsed
                  ? `flex w-full flex-col items-center gap-1 ${index > 0 ? "border-t border-md-line pt-3" : ""}`
                  : "flex flex-col gap-0.5"
              }
            >
              {!collapsed && (
                <div className="flex items-center gap-2 px-3 pb-1 pt-0.5">
                  <span className="md-shell-overline text-md-ink-soft">{group.heading}</span>
                  <span className="h-px flex-1 bg-md-line" aria-hidden="true" />
                </div>
              )}
              {group.items.map((item) =>
                collapsed ? (
                  <RailItem key={item.id} item={item} current={location} onClose={onClose} />
                ) : (
                  <Fragment key={item.id}>
                    {item.id === "approvals" ? (
                      <ApprovalsItem item={item} current={location} onClose={onClose} />
                    ) : (
                      <ExpandedItem item={item} current={location} onClose={onClose} />
                    )}
                  </Fragment>
                ),
              )}
            </div>
          ))}
        </nav>

        {/* Identity + sign out */}
        {collapsed ? (
          <div className="flex flex-col items-center gap-1 border-t border-md-line px-[10px] py-3">
            {hrAccess && (
              <Tip label="HR portal">
                <a
                  href="/hr/dashboard"
                  aria-label="HR portal"
                  data-testid="md-to-hr"
                  className="md-shell-nav md-shell-nav-rail"
                >
                  <ArrowLeftRight className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
                </a>
              </Tip>
            )}
            {/* no avatar on the rail (the HR portal's has none): the identity is still there for a screen reader */}
            <span className="sr-only" data-testid="md-identity">
              {name} · Managing Director
            </span>
            <Tip label="Sign out">
              <button
                type="button"
                onClick={logout}
                data-testid="button-logout"
                aria-label="Sign out"
                className="md-shell-nav md-shell-nav-rail md-shell-nav-danger"
              >
                <LogOut className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
              </button>
            </Tip>
          </div>
        ) : (
          <div className="space-y-1.5 border-t border-md-line px-3 pb-3 pt-3">
            <div className="md-shell-identity" data-testid="md-identity">
              <div className="md-shell-avatar">{initials}</div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-extrabold leading-tight text-md-ink">{name}</p>
                <p className="md-shell-overline mt-1.5 text-md-wine">Managing Director</p>
              </div>
            </div>
            {hrAccess && (
              <a href="/hr/dashboard" data-testid="md-to-hr" className="md-shell-quiet">
                <ArrowLeftRight className="h-4 w-4 shrink-0" strokeWidth={1.9} aria-hidden="true" />
                <span>HR portal</span>
              </a>
            )}
            <button type="button" onClick={logout} data-testid="button-logout" className="md-shell-quiet">
              <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.9} aria-hidden="true" />
              <span>Sign Out</span>
            </button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
