import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Menu, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { UKTLogo } from "@/components/ui/dashboard-sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { toggleAssistant, useAssistantState } from "@/lib/md/assistant-store";
import { useMdEmbedded } from "@/lib/md/embed";
import { useMdTheme } from "@/lib/md/theme";
import { toggleSidebarCollapsed, useIsDesktop, useSidebarCollapsed } from "@/lib/sidebar-state";
import { cn } from "@/lib/utils";
import MdEmbeddedFrame from "./embedded/MdEmbeddedFrame";
import MdSidebar from "./MdSidebar";

// Scroll positions per pathname, surviving page remounts (each MD page renders its own MdLayout, as the HR pages do).
const scrollPositions = new Map<string, number>();

/** The session ended (401): sign out once, for every MD request. The MD identity was removed (403 while the token is
 *  still valid): refresh who the user is, and the route guard sends them to the HR portal. */
function useMdSessionGuard() {
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      // The MD's own API, and the Report Center (the MD opens it from /md/reports).
      const key = String(event.query.queryKey[0] ?? "");
      const isMdApi = key === "/api/md";
      if (!isMdApi && !key.startsWith("/api/reports")) return;
      const error = event.action.error;
      if (!(error instanceof ApiError)) return;
      if (error.status === 401) logoutRef.current();
      else if (error.status === 403 && isMdApi) queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    });
  }, [queryClient]);
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** The shell of every MD page: sidebar, mobile bar, scrolling content that makes room for the assistant panel. */
export default function MdLayout({ children }: { children: ReactNode }) {
  // inside an MD copy of an HR page (lib/md/embed.ts) the page is framed with the MD's insights
  const embedded = useMdEmbedded();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: settings } = usePayrollSettings();
  const companyName = settings?.companyName || "UKTextiles";
  const companyLogo = settings?.companyLogo;
  const { open: assistantOpen } = useAssistantState();
  const mainRef = useRef<HTMLElement>(null);

  useMdSessionGuard();
  useMdTheme();

  const collapsedPref = useSidebarCollapsed();
  const isDesktop = useIsDesktop();
  const collapsed = collapsedPref && isDesktop;

  // Ctrl/Cmd+B: the rail (not while typing, where it means bold). Ctrl/Cmd+J: the assistant (works while typing too,
  // so the MD can close it from the question box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "b" && !isTyping(e.target)) {
        e.preventDefault();
        toggleSidebarCollapsed();
      } else if (key === "j") {
        e.preventDefault();
        toggleAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Restore the scroll position when coming back to a page: content usually has not loaded yet on mount, so keep
  // re-applying until it sticks, the user scrolls, or the window expires.
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const path = window.location.pathname;
    const saved = scrollPositions.get(path) ?? 0;

    let restoring = saved > 0;
    let cancelled = false;
    if (restoring) {
      const tryRestore = () => {
        if (cancelled || !restoring) return;
        el.scrollTop = saved;
        if (Math.abs(el.scrollTop - saved) < 2) restoring = false;
      };
      tryRestore();
      const observer = new ResizeObserver(tryRestore);
      for (const child of Array.from(el.children)) observer.observe(child);
      const timer = setTimeout(() => {
        restoring = false;
        observer.disconnect();
      }, 3000);
      const stop = () => {
        restoring = false;
        observer.disconnect();
        clearTimeout(timer);
      };
      el.addEventListener("wheel", stop, { once: true, passive: true });
      el.addEventListener("touchmove", stop, { once: true, passive: true });
    }

    const onScroll = () => {
      if (!restoring) scrollPositions.set(path, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelled = true;
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div
      className="md-app-bg md-shell-root flex h-screen print:block print:h-auto"
      style={{ fontFamily: "'Hanken Grotesk', 'Inter', sans-serif" }}
      data-testid="md-shell"
    >
      {/* the glass rail (and, on a small screen, the drawer): see md-theme/areas/shell.css */}
      <aside
        className={cn(
          "md-shell-rail fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 transform flex-col overflow-hidden transition-[transform,width] duration-300 ease-out print:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:relative lg:translate-x-0",
          collapsed ? "lg:w-[68px]" : "lg:w-64",
        )}
      >
        <MdSidebar
          onClose={() => setMobileOpen(false)}
          collapsed={collapsed}
          onToggleCollapse={toggleSidebarCollapsed}
        />
      </aside>

      {mobileOpen && (
        <div
          className="md-shell-scrim fixed inset-0 z-40 lg:hidden"
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden print:block print:h-auto print:overflow-visible">
        <header className="md-shell-topbar flex items-center gap-3 px-4 py-2.5 lg:hidden print:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            data-testid="button-menu"
            aria-label="Open menu"
            className="md-btn md-btn-soft md-btn-icon shrink-0"
          >
            <Menu size={18} strokeWidth={2} aria-hidden="true" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="md-shell-logo md-shell-logo-sm">
              {companyLogo ? (
                <img src={companyLogo} alt={companyName} className="h-6 w-6 rounded-full object-contain" />
              ) : (
                <UKTLogo className="h-6 w-auto" />
              )}
            </span>
            <span className="truncate text-base font-black tracking-tight text-md-wine">{companyName}</span>
          </div>
          <button
            type="button"
            onClick={toggleAssistant}
            aria-label="AI assistant"
            aria-pressed={assistantOpen}
            data-testid="md-ask-ai-mobile"
            className="md-btn md-btn-ink md-btn-icon shrink-0"
          >
            <Sparkles size={17} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </header>

        {/* `relative` keeps absolutely-positioned descendants (Radix Select's hidden native <select>) inside this
            scroll container. On wide screens the content makes room for the open assistant panel instead of hiding
            behind it. It is also the container the pages' layouts answer to (`@3xl:`, `@5xl:`...): the room a page
            has is the screen less the sidebar (full or a rail) and the assistant panel, so the screen's width alone
            says nothing about how many columns fit. */}
        <main
          ref={mainRef}
          className={cn(
            "@container relative flex-1 overflow-y-auto p-4 transition-[padding] duration-300 ease-out lg:p-6 print:static print:h-auto print:overflow-visible print:p-0",
            assistantOpen && "xl:pr-[444px]",
          )}
        >
          {embedded ? <MdEmbeddedFrame>{children}</MdEmbeddedFrame> : children}
        </main>
      </div>
    </div>
  );
}
