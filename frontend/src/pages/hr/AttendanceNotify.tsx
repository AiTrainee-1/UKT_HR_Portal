import { useCallback, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { BellRing, History, Mail, MessageCircle, MessagesSquare, Workflow } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs } from "@/components/ui/pill-tabs";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useAttendanceNotifyOverview } from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { moduleForPath } from "@/lib/permission-modules";
import { ViewOnlyTabNote, pickVisible, useLevel, useViewOnlyLock, visibleItems } from "@/lib/tab-access";
import { LiveRunBanner, NotifyActionsProvider } from "./attendance-notify/actions";
import AutomationsTab from "./attendance-notify/AutomationsTab";
import ChannelTab from "./attendance-notify/ChannelTab";
import HistoryTab from "./attendance-notify/HistoryTab";
import Overview from "./attendance-notify/Overview";
import {
  CHANNEL_TAB,
  NOTIFY_TABS,
  TAB_CHANNEL,
  TAB_KEY,
  errorText,
  historySearch,
  searchForTab,
  tabFromSearch,
  type HistoryFilters,
  type NotifyTab,
} from "./attendance-notify/logic";

const TAB_ICON: Record<NotifyTab, ReactNode> = {
  whatsapp: <MessageCircle size={14} />,
  gmail: <Mail size={14} />,
  chat: <MessagesSquare size={14} />,
  automations: <Workflow size={14} />,
  history: <History size={14} />,
};

/**
 * Attendance Notify (Attendance -> Attendance Notify, owner 2026-11-17): attendance reports (Absent, CL, On Leave,
 * Permission, Compensation; Staff / Production / everyone) sent on a schedule through WhatsApp, Gmail and the Internal Chat.
 *
 *   the dashboard            the three channels and whether each can deliver, today's numbers, the automations at a glance
 *   WhatsApp / Gmail / Internal Chat   that channel's automations, and "New automation" (a stepped form with a preview)
 *   Automation Management    every automation in one table: switch on / off, run now, edit, history, delete
 *   Execution History        every send and what happened to each recipient; retry the failed ones
 *
 * The tab is in the address (`?tab=`); the history's filters too (`&automation=&channel=&status=&page=&run=`).
 */
export default function AttendanceNotify() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { user } = useAuth();
  const level = useLevel();

  const overview = useAttendanceNotifyOverview();
  const counts = overview.data?.counts;
  const tabs = visibleItems(NOTIFY_TABS, (t) => TAB_KEY[t.value], level).map((t) => {
    const channel = TAB_CHANNEL[t.value];
    return {
      value: t.value,
      label: t.label,
      icon: TAB_ICON[t.value],
      count: counts
        ? channel
          ? counts.byChannel[channel]
          : t.value === "automations"
            ? counts.automations
            : undefined
        : undefined,
    };
  });
  const values = tabs.map((t) => t.value);
  const tab = pickVisible(tabFromSearch(search), values);
  // a tab this role may only VIEW on a page it may edit: its change buttons are locked (HrLayout locks a View-only page)
  const tabViewOnly =
    tabs.length > 0 && !isRouteViewOnly(user, location, moduleForPath(location)) && level(TAB_KEY[tab]) === "view";
  useViewOnlyLock(tabViewOnly, tab);

  const openTab = (t: NotifyTab) => navigate(`${location}?${searchForTab(search, t)}`);
  const showHistory = useCallback(
    (f: Partial<HistoryFilters>) => navigate(`${location}?${historySearch(search, f)}`),
    [location, navigate, search],
  );

  const overviewError = overview.isError
    ? overview.error instanceof ApiError && overview.error.status === 404
      ? "Attendance Notify is not available on this server yet: it arrives with the next server update."
      : `The dashboard could not be loaded: ${errorText(overview.error) ?? "the server did not answer"}.`
    : null;

  const channel = TAB_CHANNEL[tab];

  return (
    <HrLayout>
      <NotifyActionsProvider overview={overview.data} onShowHistory={showHistory}>
        <div className="space-y-5 pb-8" data-testid="attendance-notify-page">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-indigo-600 p-2.5 text-white shadow-sm">
                <BellRing size={22} />
              </div>
              <div>
                <h2 className="text-2xl font-black text-gray-900">Attendance Notify</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Send attendance reports on a schedule by WhatsApp, Gmail and the Internal Chat, and see every send.
                </p>
              </div>
            </div>
            <RefreshButton />
          </div>

          <Overview
            overview={overview.data}
            loading={overview.isLoading}
            error={overviewError}
            onRetry={() => void overview.refetch()}
            canOpen={(c) => values.includes(CHANNEL_TAB[c])}
            onOpen={(c) => openTab(CHANNEL_TAB[c])}
          />

          {tabs.length === 0 ? (
            <p
              className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground"
              data-testid="nothing-open"
            >
              None of the tabs of this page is open to your role.
            </p>
          ) : (
            <div className="max-w-full overflow-x-auto pb-0.5" data-tab-row data-view-safe data-testid="an-tabs">
              <PillTabs items={tabs} value={tab} onChange={(v) => openTab(v as NotifyTab)} />
            </div>
          )}

          <ViewOnlyTabNote show={tabViewOnly} />
          <LiveRunBanner />

          {tabs.length > 0 && (
            <div role="tabpanel" aria-label={NOTIFY_TABS.find((t) => t.value === tab)?.label}>
              {channel && <ChannelTab key={channel} channel={channel} overview={overview.data} />}
              {tab === "automations" && <AutomationsTab />}
              {tab === "history" && <HistoryTab />}
            </div>
          )}
        </div>
      </NotifyActionsProvider>
    </HrLayout>
  );
}
