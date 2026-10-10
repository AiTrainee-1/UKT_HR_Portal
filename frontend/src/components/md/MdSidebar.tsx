import { Link, useLocation } from "wouter";
import { ArrowLeftRight, LogOut, Sparkles, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarToggle } from "@/components/ui/sidebar-toggle";
import { UKTLogo } from "@/components/ui/dashboard-sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { toggleAssistant, useAssistantState } from "@/lib/md/assistant-store";
import { hasHrAccess } from "@/lib/md/access";
import { hrToMd } from "@/lib/md/embed";
import { cn } from "@/lib/utils";
import { MD_NAV_GROUPS, type MdNavItem } from "./md-nav";

/** The Managing Director's gold: the identity colour that sets this portal apart from the blue HR one. */
export const MD_GOLD = "#e0a83a";
export const MD_GOLD_GRADIENT = "linear-gradient(135deg, #f6d27a 0%, #e0a83a 100%)";

const isActivePath = (current: string, path: string) => {
  const now = current.toLowerCase();
  const own = path.toLowerCase();
  return now === own || now.startsWith(`${own}/`);
};

function ExpandedItem({ item, current, onClose }: { item: MdNavItem; current: string; onClose: () => void }) {
  const active = isActivePath(current, item.path);
  return (
    <Link href={item.path} onClick={onClose} data-testid={`md-nav-${item.id}`}>
      <div
        className={cn(
          "group flex cursor-pointer select-none items-center gap-2.5 rounded-xl py-[8px] pl-[10px] pr-3 transition-all duration-200",
          active
            ? "clay-nav-active"
            : "text-[#1e4d6b] hover:translate-x-1 hover:bg-[#006496]/[0.05] hover:text-[#006496]",
        )}
        aria-current={active ? "page" : undefined}
      >
        <item.icon
          className={cn(
            "h-4 w-4 shrink-0 transition-colors",
            active ? "text-white" : "text-[#006496]/80 group-hover:text-[#006496]",
          )}
          strokeWidth={1.8}
        />
        <span className={cn("truncate text-[13px] font-medium", active && "text-white")}>
          {item.navLabel ?? item.title}
        </span>
      </div>
    </Link>
  );
}

function RailItem({ item, current, onClose }: { item: MdNavItem; current: string; onClose: () => void }) {
  const active = isActivePath(current, item.path);
  return (
    <Link href={item.path} onClick={onClose} aria-label={item.title} data-testid={`md-nav-${item.id}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "relative flex h-11 w-12 cursor-pointer select-none items-center justify-center rounded-xl transition-all duration-200",
              active ? "clay-nav-active" : "text-[#006496]/80 hover:bg-[#006496]/[0.08] hover:text-[#006496]",
            )}
          >
            {active && (
              <span className="absolute -left-[10px] bottom-2.5 top-2.5 w-[3px] rounded-r-full bg-[#006496]" />
            )}
            <item.icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10}>
          {item.title}
        </TooltipContent>
      </Tooltip>
    </Link>
  );
}

/** The MD portal's navigation: the same clay sidebar as the HR portal, with the MD's gold identity and the assistant's
 *  entry point. Collapses to an icon rail on desktop (Ctrl+B), is a drawer on small screens. */
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

  const railBtn = "flex h-11 w-12 shrink-0 items-center justify-center rounded-xl transition-all duration-200";

  return (
    <TooltipProvider delayDuration={120}>
      <div className="relative flex h-full flex-col" style={{ fontFamily: "'Hanken Grotesk', 'Inter', sans-serif" }}>
        {/* Header */}
        <div
          className={cn("flex items-center py-3", collapsed ? "px-[10px]" : "pl-4 pr-3")}
          style={{ borderBottom: "1px solid rgba(0,100,150,0.08)" }}
        >
          {!collapsed && (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {companyLogo ? (
                  <img
                    src={companyLogo}
                    alt={companyName}
                    className="h-9 w-9 shrink-0 rounded-full bg-white object-contain"
                  />
                ) : (
                  <UKTLogo className="h-9 w-auto shrink-0" />
                )}
                <div className="min-w-0">
                  <h1
                    className="truncate text-[15px] font-black leading-none tracking-tight"
                    style={{ color: "#006496" }}
                  >
                    {companyName}
                  </h1>
                  <p
                    className="mt-0.5 flex items-center gap-1 text-[10px] font-extrabold uppercase leading-none tracking-widest"
                    style={{ color: "#b8801c" }}
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: MD_GOLD_GRADIENT }} />
                    MD Portal
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="shrink-0 rounded-lg p-1.5 transition-colors lg:hidden"
                style={{ color: "rgba(0,100,150,0.4)" }}
                aria-label="Close menu"
              >
                <X className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </>
          )}
          {onToggleCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarToggle
                  collapsed={collapsed}
                  onToggle={onToggleCollapse}
                  compact={!collapsed}
                  className="hidden lg:flex"
                />
              </TooltipTrigger>
              <TooltipContent side={collapsed ? "right" : "bottom"} sideOffset={10}>
                {collapsed ? "Expand sidebar" : "Collapse sidebar"} <span className="ml-1 opacity-60">Ctrl+B</span>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Ask AI */}
        <div
          className={cn("py-3", collapsed ? "flex justify-center px-[10px]" : "px-3")}
          style={{ borderBottom: "1px solid rgba(0,100,150,0.06)" }}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleAssistant}
                  aria-label="AI assistant"
                  aria-pressed={assistantOpen}
                  data-testid="md-ask-ai"
                  className={cn(railBtn, "text-[#5b3d00] shadow-sm hover:brightness-105")}
                  style={{ background: MD_GOLD_GRADIENT }}
                >
                  <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}>
                AI assistant <span className="ml-1 opacity-60">Ctrl+J</span>
              </TooltipContent>
            </Tooltip>
          ) : (
            <button
              onClick={toggleAssistant}
              aria-pressed={assistantOpen}
              data-testid="md-ask-ai"
              className="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[#5b3d00] shadow-sm transition-all hover:brightness-105 hover:shadow-md"
              style={{ background: MD_GOLD_GRADIENT }}
            >
              <Sparkles className="h-4 w-4 shrink-0 transition-transform group-hover:rotate-12" strokeWidth={2} />
              <span className="flex-1 text-[13px] font-extrabold">Ask the AI assistant</span>
              <span className="rounded-md bg-white/40 px-1.5 py-0.5 text-[10px] font-bold">Ctrl J</span>
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav
          className={cn(
            "flex flex-1 flex-col overflow-y-auto py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            collapsed ? "items-center gap-3 px-[10px]" : "gap-4 px-2.5",
          )}
        >
          {MD_NAV_GROUPS.map((group, index) => (
            <div
              key={group.heading}
              className={
                collapsed
                  ? cn("flex w-full flex-col items-center gap-1", index > 0 && "border-t pt-3")
                  : "flex flex-col gap-0.5"
              }
              style={collapsed && index > 0 ? { borderColor: "rgba(0,100,150,0.1)" } : undefined}
            >
              {!collapsed && (
                <span
                  className="mb-1 px-3 text-[9.5px] font-extrabold uppercase tracking-[0.2em]"
                  style={{ color: "rgba(0,60,100,0.45)" }}
                >
                  {group.heading}
                </span>
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
          <div
            className="flex flex-col items-center gap-2 px-[10px] py-3"
            style={{ borderTop: "1px solid rgba(0,100,150,0.08)" }}
          >
            {hrAccess && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a href="/hr/dashboard" aria-label="HR portal" data-testid="md-to-hr">
                    <span className={cn(railBtn, "text-[#006496]/70 hover:bg-[#006496]/[0.08] hover:text-[#006496]")}>
                      <ArrowLeftRight className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </span>
                  </a>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={10}>
                  HR portal
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-black text-[#5b3d00] ring-2 ring-white"
                  style={{ background: MD_GOLD_GRADIENT }}
                  data-testid="md-identity"
                >
                  {initials}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}>
                {name} · Managing Director
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={logout}
                  data-testid="button-logout"
                  aria-label="Sign out"
                  className={cn(railBtn, "text-[#006496]/55 hover:bg-[#c0392b]/[0.07] hover:text-[#c0392b]")}
                >
                  <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}>
                Sign out
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <div className="space-y-1 px-3 py-3" style={{ borderTop: "1px solid rgba(0,100,150,0.08)" }}>
            <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5" data-testid="md-identity">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-black text-[#5b3d00] ring-2 ring-white"
                style={{ background: MD_GOLD_GRADIENT }}
              >
                {initials}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-bold text-[#1a3a4a]">{name}</p>
                <p className="text-[10px] font-extrabold uppercase tracking-widest" style={{ color: "#b8801c" }}>
                  Managing Director
                </p>
              </div>
            </div>
            {hrAccess && (
              <a href="/hr/dashboard" data-testid="md-to-hr">
                <div className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium text-[#1e4d6b] transition-all duration-200 hover:translate-x-1 hover:bg-[#006496]/[0.05] hover:text-[#006496]">
                  <ArrowLeftRight className="h-4 w-4 shrink-0 text-[#006496]/80" strokeWidth={1.8} />
                  <span>HR portal</span>
                </div>
              </a>
            )}
            <button
              onClick={logout}
              data-testid="button-logout"
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-all duration-200 hover:translate-x-1 hover:bg-[#c0392b]/[0.06] hover:text-[#c0392b]"
              style={{ color: "rgba(0,100,150,0.55)" }}
            >
              <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              <span>Sign Out</span>
            </button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
