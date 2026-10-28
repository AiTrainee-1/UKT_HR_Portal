import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { lockMutatingControls } from "@/lib/view-only-lock";
import "./settings/settings-skin.css";
import { settingsTabLevel } from "./settings/access";
import { UNLISTED_TABS } from "./settings/constants";
import { SETTINGS_TABS, SETTINGS_TAB_COMPONENTS } from "./settings/tabs";
import { ALL_SETTINGS } from "./settings/metas";
import { SettingsNav } from "./settings/kit/SettingsNav";
import { SettingsSearch } from "./settings/kit/SettingsSearch";
import { ViewOnlyNotice } from "./settings/kit/SettingBlock";
import { focusSetting, parseSettingsAddress, settingsAddress } from "./settings/kit/jump";
import { confirmLeaveTab } from "./settings/kit/leaveGuard";
import type { SettingMeta } from "./settings/kit/catalog";
import { ArrowUpRight } from "lucide-react";

const FIRST_TAB = SETTINGS_TABS[0].id;
const isTab = (id: string | null): id is string => !!id && SETTINGS_TABS.some((t) => t.id === id);

export default function Settings() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();

  const tabLevel = useCallback((tab: string) => settingsTabLevel(user, tab), [user]);
  const visibleTabs = useMemo(() => SETTINGS_TABS.filter((t) => tabLevel(t.id) !== "hidden"), [tabLevel]);
  // What the menu and the search offer: the tabs this login may open, minus the ones that open only from their address.
  const listedTabs = useMemo(() => visibleTabs.filter((t) => !UNLISTED_TABS.has(t.id)), [visibleTabs]);

  // The tab (and the setting) come from the address, so a link such as /hr/settings?tab=attendance#late-window works.
  // /hr/settings/<tab> is the same address as /hr/settings?tab=<tab> (the path wins when both are given).
  const [, pathParams] = useRoute<{ tab: string }>("/hr/settings/:tab");
  const askedInPath = pathParams?.tab ? decodeURIComponent(pathParams.tab) : null;
  const asked = parseSettingsAddress(search, typeof window === "undefined" ? "" : window.location.hash);
  if (askedInPath) asked.tab = askedInPath;
  const [settingsTab, setSettingsTabState] = useState<string>(isTab(asked.tab) ? asked.tab : FIRST_TAB);
  const settingsTabRef = useRef(settingsTab);
  settingsTabRef.current = settingsTab;

  const setSettingsTab = useCallback(
    (id: string, setting?: string | null) => {
      // a tab with work that is not saved yet (Endpoint Sharing's editor) asks before another tab replaces it
      if (id !== settingsTabRef.current && !confirmLeaveTab()) return;
      setSettingsTabState(id);
      navigate(settingsAddress(id, setting), { replace: true });
    },
    [navigate],
  );

  // Follow the address when it changes from outside (a link on another page, the back button).
  useEffect(() => {
    const next = parseSettingsAddress(search, window.location.hash);
    if (askedInPath) next.tab = askedInPath;
    if (isTab(next.tab)) setSettingsTabState(next.tab);
  }, [search, askedInPath]);

  // Land on the first tab this role can actually see if the one asked for is hidden for them. (Until the login is known
  // nothing is hidden or shown yet: a super-admin-only tab asked for in the address must survive the sign-in check.)
  useEffect(() => {
    if (user && tabLevel(settingsTab) === "hidden") {
      const first = visibleTabs[0];
      if (first) setSettingsTabState(first.id);
    }
  }, [settingsTab, tabLevel, visibleTabs, user]);

  // A setting named in the address (or picked in the search) is scrolled to once its tab has drawn it.
  const [wanted, setWanted] = useState<{ id: string; n: number } | null>(
    asked.setting ? { id: asked.setting, n: 0 } : null,
  );
  useEffect(() => {
    if (!wanted) return;
    return focusSetting(wanted.id);
  }, [wanted]);

  // The tab drawn: the one asked for, unless it is hidden for this login, and then the first visible one, on the very first
  // render too (so a direct address of a hidden tab never flashes its content).
  const shownId = tabLevel(settingsTab) === "hidden" ? (visibleTabs[0]?.id ?? FIRST_TAB) : settingsTab;
  const tab = SETTINGS_TABS.find((t) => t.id === shownId) ?? SETTINGS_TABS[0];
  const Panel = SETTINGS_TAB_COMPONENTS[tab.id];
  const level = tabLevel(tab.id);
  const isTabViewOnly = level === "view";

  // The plain, flat look is for this page only (settings/settings-skin.css): the page root carries `.settings-skin`, and
  // <html> carries `.settings-skin-on` while the page is open so the dialogs and menus it opens (they render in a portal)
  // get the same look. Leaving the page takes it off again.
  useEffect(() => {
    document.documentElement.classList.add("settings-skin-on");
    return () => document.documentElement.classList.remove("settings-skin-on");
  }, []);

  // Only the open tab is mounted, so locking document.body while it is view-only (the mechanism HrLayout uses
  // page-wide) only ever touches that one tab's controls.
  useEffect(() => {
    if (!isTabViewOnly) return;
    const relock = () => lockMutatingControls(document.body);
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isTabViewOnly, settingsTab]);

  const pick = (meta: SettingMeta) => {
    setSettingsTab(meta.tab, meta.id);
    setWanted((w) => ({ id: meta.id, n: (w?.n ?? 0) + 1 }));
  };

  const TabIcon = tab.icon;

  return (
    <HrLayout>
      <div className="settings-skin space-y-5" data-testid="settings-page">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[26rem]">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Settings</h2>
            <p className="mt-1 text-sm text-slate-500">
              The defaults the whole system runs on. Every setting says what it is for and what changes when you change
              it.
            </p>
          </div>
          <SettingsSearch metas={ALL_SETTINGS} tabs={listedTabs} onPick={pick} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <SettingsNav tabs={listedTabs} value={tab.id} onChange={(id) => setSettingsTab(id)} />

          <div
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab.id}`}
            className="min-w-0 space-y-4"
            data-testid={`settings-panel-${tab.id}`}
          >
            <header className="settings-hero flex items-start gap-3 pb-4 text-slate-900">
              <span className="mt-0.5 rounded-lg bg-slate-100 p-2.5 text-slate-600">
                <TabIcon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold leading-tight">{tab.label}</h3>
                <p className="mt-1 text-[13px] leading-snug text-slate-500">{tab.purpose}</p>
                {tab.usedBy.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Used by</span>
                    {tab.usedBy.map((u) =>
                      u.to ? (
                        <Link
                          key={u.label}
                          href={u.to}
                          className="settings-chip inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-[#006496]"
                        >
                          {u.label}
                          <ArrowUpRight size={10} />
                        </Link>
                      ) : (
                        <span
                          key={u.label}
                          className="settings-chip px-2 py-0.5 text-[11px] font-medium text-slate-600"
                        >
                          {u.label}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>
            </header>

            {isTabViewOnly && <ViewOnlyNotice />}

            <Suspense
              fallback={
                <div className="space-y-3" data-testid="settings-loading">
                  <Skeleton className="h-32 w-full rounded-xl" />
                  <Skeleton className="h-48 w-full rounded-xl" />
                </div>
              }
            >
              <Panel readOnly={isTabViewOnly} />
            </Suspense>
          </div>
        </div>
      </div>
    </HrLayout>
  );
}
