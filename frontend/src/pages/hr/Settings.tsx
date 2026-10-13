import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, permissionLevel } from "@/contexts/AuthContext";
import { lockMutatingControls } from "@/lib/view-only-lock";
import "./settings/settings-skin.css";
import { SETTINGS_TAB_MODULE } from "./settings/constants";
import { SETTINGS_TABS, SETTINGS_TAB_COMPONENTS } from "./settings/tabs";
import { ALL_SETTINGS } from "./settings/metas";
import { SettingsNav } from "./settings/kit/SettingsNav";
import { SettingsSearch } from "./settings/kit/SettingsSearch";
import { ViewOnlyNotice } from "./settings/kit/SettingBlock";
import { focusSetting, parseSettingsAddress, settingsAddress } from "./settings/kit/jump";
import type { SettingMeta } from "./settings/kit/catalog";
import { ArrowUpRight } from "lucide-react";

const FIRST_TAB = SETTINGS_TABS[0].id;
const isTab = (id: string | null): id is string => !!id && SETTINGS_TABS.some((t) => t.id === id);

export default function Settings() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();

  const tabLevel = useCallback((tab: string) => permissionLevel(user, SETTINGS_TAB_MODULE[tab] ?? "settings"), [user]);
  const visibleTabs = useMemo(() => SETTINGS_TABS.filter((t) => tabLevel(t.id) !== "hidden"), [tabLevel]);

  // The tab (and the setting) come from the address, so a link such as /hr/settings?tab=attendance#late-window works.
  const asked = parseSettingsAddress(search, typeof window === "undefined" ? "" : window.location.hash);
  const [settingsTab, setSettingsTabState] = useState<string>(isTab(asked.tab) ? asked.tab : FIRST_TAB);

  const setSettingsTab = useCallback(
    (id: string, setting?: string | null) => {
      setSettingsTabState(id);
      navigate(settingsAddress(id, setting), { replace: true });
    },
    [navigate],
  );

  // Follow the address when it changes from outside (a link on another page, the back button).
  useEffect(() => {
    const next = parseSettingsAddress(search, window.location.hash);
    if (isTab(next.tab)) setSettingsTabState(next.tab);
  }, [search]);

  // Land on the first tab this role can actually see if the one asked for is hidden for them.
  useEffect(() => {
    if (tabLevel(settingsTab) === "hidden") {
      const first = visibleTabs[0];
      if (first) setSettingsTabState(first.id);
    }
  }, [settingsTab, tabLevel, visibleTabs]);

  // A setting named in the address (or picked in the search) is scrolled to once its tab has drawn it.
  const [wanted, setWanted] = useState<{ id: string; n: number } | null>(
    asked.setting ? { id: asked.setting, n: 0 } : null,
  );
  useEffect(() => {
    if (!wanted) return;
    return focusSetting(wanted.id);
  }, [wanted]);

  const tab = SETTINGS_TABS.find((t) => t.id === settingsTab) ?? SETTINGS_TABS[0];
  const Panel = SETTINGS_TAB_COMPONENTS[tab.id];
  const level = tabLevel(tab.id);
  const isTabViewOnly = level === "view";

  // The glass-and-clay look is for this page only (settings/settings-skin.css): the page root carries `.settings-skin`, and
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
            <h2 className="text-2xl font-black text-gray-900">Settings</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The defaults the whole system runs on. Every setting says what it is for and what changes when you change
              it.
            </p>
          </div>
          <SettingsSearch metas={ALL_SETTINGS} tabs={visibleTabs} onPick={pick} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <SettingsNav tabs={visibleTabs} value={settingsTab} onChange={(id) => setSettingsTab(id)} />

          <div
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${tab.id}`}
            className="min-w-0 space-y-4"
            data-testid={`settings-panel-${tab.id}`}
          >
            <header className="settings-hero flex items-start gap-3.5 rounded-3xl p-5 text-white">
              <span className="mt-0.5 rounded-2xl bg-white/20 p-3 ring-1 ring-white/40 backdrop-blur">
                <TabIcon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-black leading-tight">{tab.label}</h3>
                <p className="mt-0.5 text-[13px] leading-snug text-white/85">{tab.purpose}</p>
                {tab.usedBy.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-white/60">Used by</span>
                    {tab.usedBy.map((u) =>
                      u.to ? (
                        <Link
                          key={u.label}
                          href={u.to}
                          className="inline-flex items-center gap-0.5 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/25"
                        >
                          {u.label}
                          <ArrowUpRight size={10} />
                        </Link>
                      ) : (
                        <span key={u.label} className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold">
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
                  <Skeleton className="h-32 w-full rounded-2xl" />
                  <Skeleton className="h-48 w-full rounded-2xl" />
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
