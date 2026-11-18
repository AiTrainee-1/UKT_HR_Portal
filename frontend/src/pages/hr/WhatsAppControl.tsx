import { useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import {
  BarChart3,
  FileText,
  FlaskConical,
  ListChecks,
  MessageCircle,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import type { WhatsAppCategory } from "@/lib/api-client/custom-hooks";
import ConfigTab from "./whatsapp-control/ConfigTab";
import ControlsTab from "./whatsapp-control/ControlsTab";
import EmployeesTab from "./whatsapp-control/EmployeesTab";
import { tabFromSearch, tabHref } from "./whatsapp-control/logic";
import MessagesTab, { type MessageFilterPreset } from "./whatsapp-control/MessagesTab";
import OverviewTab from "./whatsapp-control/OverviewTab";
import TemplatesTab from "./whatsapp-control/TemplatesTab";
import TestTab from "./whatsapp-control/TestTab";
import { WA_PATH, WA_TABS, waTabModule, type WaTab } from "./whatsapp-control/tabs";

const ICON: Record<WaTab, ReactNode> = {
  overview: <BarChart3 size={13} />,
  messages: <ListChecks size={13} />,
  employees: <Users size={13} />,
  controls: <SlidersHorizontal size={13} />,
  templates: <FileText size={13} />,
  test: <FlaskConical size={13} />,
  config: <Settings2 size={13} />,
};

const TABS = WA_TABS.map((t) => ({ ...t, icon: ICON[t.value] }));

// Each tab has its own permission key (Account Management); with no setting of its own it follows the page.
const tabModule = waTabModule;

export default function WhatsAppControl() {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const level = useLevel();
  // The open tab is in the address (?tab=controls), so a link from another page (Requests -> Notify) opens it.
  const askedTab = tabFromSearch(search);
  const setTab = (next: string) => navigate(tabHref(WA_PATH, next));
  // Only the tabs this role may see are offered, and the one shown is always one of them (only it is mounted, so a
  // hidden tab asks the server for nothing). A tab the role may only VIEW on a page it may edit gets the note and lock.
  const visibleTabs = visibleItems(TABS, (t) => tabModule(t.value), level);
  const visibleValues: string[] = visibleTabs.map((t) => t.value);
  const tab = pickVisible(askedTab, visibleValues);
  const canOpen = (t: WaTab) => visibleValues.includes(t);
  const tabViewOnly =
    visibleTabs.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level(tabModule(tab)) === "view";
  useViewOnlyLock(tabViewOnly, tab);
  const [preset, setPreset] = useState<MessageFilterPreset>({});
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/whatsapp") }) > 0;

  // Shortcuts from the Overview into a pre-filtered Messages tab.
  const openMessages = (next: MessageFilterPreset) => {
    setPreset(next);
    setTab("messages");
  };
  const showCategory = (category: WhatsAppCategory) => openMessages({ category });

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <MessageCircle size={22} className="text-emerald-600" /> WhatsApp Control
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Monitor every WhatsApp message the HRMS sends, and switch each feature on or off
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() =>
              queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/whatsapp") })
            }
            disabled={fetching}
          >
            <RefreshCw size={13} className={fetching ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="whatsapp-control-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          // tabs only move around the page: "Send a test" must stay open to a View-only role (the lock reads "send")
          <div data-view-safe="">
            <PillTabs className="flex-wrap h-auto" size="sm" items={visibleTabs} value={tab} onChange={setTab} />
          </div>
        )}

        <ViewOnlyTabNote show={tabViewOnly} />

        {/* the Overview's shortcuts into another tab are only offered when that tab is open to the role */}
        {tab === "overview" && canOpen("overview") && (
          <OverviewTab
            onOpenCategory={canOpen("messages") ? showCategory : undefined}
            onOpenFailures={canOpen("messages") ? () => openMessages({ status: "failed" }) : undefined}
            onOpenConfig={canOpen("config") ? () => setTab("config") : undefined}
            onOpenControls={canOpen("controls") ? () => setTab("controls") : undefined}
            canReadTypes={canOpen("templates")}
          />
        )}
        {tab === "messages" && canOpen("messages") && <MessagesTab preset={preset} />}
        {tab === "employees" && canOpen("employees") && <EmployeesTab />}
        {tab === "controls" && canOpen("controls") && <ControlsTab />}
        {tab === "templates" && canOpen("templates") && <TemplatesTab />}
        {tab === "test" && canOpen("test") && (
          <TestTab
            viewOnly={isRouteViewOnly(user, location, moduleForPath(location)) || level(tabModule("test")) === "view"}
          />
        )}
        {tab === "config" && canOpen("config") && <ConfigTab />}
      </div>
    </HrLayout>
  );
}
