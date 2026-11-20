import { useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import {
  BarChart3,
  FileText,
  FlaskConical,
  IndianRupee,
  KeyRound,
  ListChecks,
  MessageCircle,
  Settings2,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import ConfigTab from "./whatsapp-control/ConfigTab";
import ControlsTab from "./whatsapp-control/ControlsTab";
import EmployeesTab from "./whatsapp-control/EmployeesTab";
import { tabFromSearch, tabHref } from "./whatsapp-control/logic";
import MessagesTab, { type MessageFilterPreset } from "./whatsapp-control/MessagesTab";
import OtpTab from "./whatsapp-control/OtpTab";
import OverviewTab from "./whatsapp-control/OverviewTab";
import TemplatesTab from "./whatsapp-control/TemplatesTab";
import TestTab from "./whatsapp-control/TestTab";
import UsageTab from "./whatsapp-control/UsageTab";
import { WA_PATH, WA_TABS, waTabModule, type WaAccess, type WaTab } from "./whatsapp-control/tabs";

const ICON: Record<WaTab, ReactNode> = {
  overview: <BarChart3 size={13} />,
  usage: <IndianRupee size={13} />,
  controls: <SlidersHorizontal size={13} />,
  templates: <FileText size={13} />,
  otp: <KeyRound size={13} />,
  messages: <ListChecks size={13} />,
  employees: <Users size={13} />,
  test: <FlaskConical size={13} />,
  config: <Settings2 size={13} />,
};

const TABS = WA_TABS.map((t) => ({ ...t, icon: ICON[t.value] }));

/**
 * WhatsApp Control: the one place for everything WhatsApp in UK Textiles HRMS, sent through the official Meta WhatsApp
 * Cloud API (since 2026-11-20). Overview (the number's health, the month's spend), Usage & Cost,
 * Message Controls (a switch for every message type, its template, the limits and the queue), Templates (Meta templates:
 * create, submit, sync, delete), OTP (WhatsApp codes, independent of SMS), Messages, Employees, Send a test and Settings
 * (the set-up check, the webhook, prices and budget).
 *
 * The open tab is in the address (?tab=usage), so a link from another page opens it. Each tab has its own permission key
 * (whatsapp_control.<tab>, following the page while unset); only the tabs the role may see are offered, only the open
 * one is mounted (a hidden tab asks the server for nothing), and a card never asks for data guarded by a tab the role
 * cannot open. A tab the role may only VIEW gets the note, the page's lock, and its own switches disabled.
 */
export default function WhatsAppControl() {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const level = useLevel();
  const askedTab = tabFromSearch(search);
  const go = (next: WaTab) => navigate(tabHref(WA_PATH, next));
  const visibleTabs = visibleItems(TABS, (t) => waTabModule(t.value), level);
  const visibleValues: string[] = visibleTabs.map((t) => t.value);
  const tab = pickVisible(askedTab, visibleValues) as WaTab;
  const routeViewOnly = isRouteViewOnly(user, location, moduleForPath(location));
  const access: WaAccess = {
    canOpen: (t) => visibleValues.includes(t),
    canEdit: (t) => visibleValues.includes(t) && !routeViewOnly && level(waTabModule(t)) === "edit",
  };
  const tabViewOnly = visibleTabs.length > 0 && !routeViewOnly && level(waTabModule(tab)) === "view";
  useViewOnlyLock(tabViewOnly, tab);
  const [preset, setPreset] = useState<MessageFilterPreset>({});
  const locked = !access.canEdit(tab);
  // a shortcut from the Overview into a pre-filtered Messages tab
  const openFailures = () => {
    setPreset({ status: "failed" });
    go("messages");
  };

  // the tabs are worked out from who is signed in: nothing is asked of the server before that is known
  if (!user) {
    return (
      <HrLayout>
        <Skeleton className="h-96 rounded-3xl" data-testid="whatsapp-control-waiting" />
      </HrLayout>
    );
  }

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="whatsapp-control-page">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            {/* the title sits on the layout's own light background: a fixed dark ink, as on the other control pages */}
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <MessageCircle size={22} className="text-emerald-600" /> WhatsApp Control
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every WhatsApp message UK Textiles HRMS sends, through the official Meta WhatsApp Cloud API
            </p>
          </div>
          <RefreshButton />
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="whatsapp-control-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          // tabs only move around the page: "Send a test" must stay open to a View-only role (the lock reads "send")
          <div className="max-w-full overflow-x-auto" data-view-safe="" data-testid="wa-tabs">
            <PillTabs
              className="h-auto flex-wrap"
              size="sm"
              baseColor="#047857"
              items={visibleTabs}
              value={tab}
              onChange={(next) => {
                setPreset({});
                go(next as WaTab);
              }}
            />
          </div>
        )}

        <ViewOnlyTabNote show={tabViewOnly} />

        {visibleTabs.length > 0 && (
          <div role="tabpanel" aria-label={WA_TABS.find((t) => t.value === tab)?.label} data-testid={`wa-panel-${tab}`}>
            {tab === "overview" && (
              <OverviewTab
                access={access}
                go={go}
                onOpenFailures={access.canOpen("messages") ? openFailures : undefined}
              />
            )}
            {tab === "usage" && <UsageTab access={access} go={go} />}
            {tab === "controls" && <ControlsTab access={access} go={go} />}
            {tab === "templates" && <TemplatesTab access={access} go={go} />}
            {tab === "otp" && <OtpTab access={access} go={go} />}
            {tab === "messages" && <MessagesTab preset={preset} />}
            {tab === "employees" && <EmployeesTab locked={locked} />}
            {tab === "test" && <TestTab viewOnly={locked} />}
            {tab === "config" && <ConfigTab locked={locked} />}
          </div>
        )}
      </div>
    </HrLayout>
  );
}
