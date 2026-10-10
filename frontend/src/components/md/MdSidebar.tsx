import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeftRight, LogOut, Menu, PanelLeftClose, Sparkles, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UKTLogo } from "@/components/ui/dashboard-sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { toggleAssistant, useAssistantState } from "@/lib/md/assistant-store";
import { hasHrAccess } from "@/lib/md/access";
import { hrToMd } from "@/lib/md/embed";
import { MD_PALETTE } from "@/lib/md/theme";
import { cn } from "@/lib/utils";
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

function RailItem({ item, current, onClose }: { item: MdNavItem; current: string; onClose: () => void }) {
  const active = isActivePath(current, item.path);
  return (
    <Tip label={item.title}>
      <Link
        href={item.path}
        onClick={onClose}
        aria-label={item.title}
        aria-current={active ? "page" : undefined}
        data-testid={`md-nav-${item.id}`}
        className="md-shell-nav md-shell-nav-rail"
      >
        <item.icon className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
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
                  <ExpandedItem key={item.id} item={item} current={location} onClose={onClose} />
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
