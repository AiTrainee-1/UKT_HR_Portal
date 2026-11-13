import { useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import { BarChart3, FileText, ListChecks, Mail, RefreshCw, Settings2, SlidersHorizontal, Users } from "lucide-react";
import type { GmailCategory } from "@/lib/api-client/custom-hooks";
import ConfigTab from "./gmail-control/ConfigTab";
import ControlsTab from "./gmail-control/ControlsTab";
import EmployeesTab from "./gmail-control/EmployeesTab";
import MessagesTab, { type MessageFilterPreset } from "./gmail-control/MessagesTab";
import OverviewTab from "./gmail-control/OverviewTab";
import TemplatesTab from "./gmail-control/TemplatesTab";

const TABS = [
  { value: "overview", label: "Overview", icon: <BarChart3 size={13} /> },
  { value: "messages", label: "Messages", icon: <ListChecks size={13} /> },
  { value: "employees", label: "Employees", icon: <Users size={13} /> },
  { value: "controls", label: "Feature Controls", icon: <SlidersHorizontal size={13} /> },
  { value: "templates", label: "Message Text", icon: <FileText size={13} /> },
  { value: "config", label: "Configuration", icon: <Settings2 size={13} /> },
];

// Each tab has its own permission key (Account Management); with no setting of its own it follows the page.
const tabModule = (tab: string) => `gmail_control.${tab}`;

const isGmailQuery = (q: { queryKey: readonly unknown[] }) => String(q.queryKey[0]).startsWith("/api/gmail-control");

export default function GmailControl() {
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  const [askedTab, setTab] = useState("overview");
  // Only the tabs this role may see are offered, and the one shown is always one of them (only it is mounted, so a
  // hidden tab asks the server for nothing). A tab the role may only VIEW on a page it may edit gets the note and lock.
  const visibleTabs = visibleItems(TABS, (t) => tabModule(t.value), level);
  const visibleValues = visibleTabs.map((t) => t.value);
  const tab = pickVisible(askedTab, visibleValues);
  const canOpen = (t: string) => visibleValues.includes(t);
  const tabViewOnly =
    visibleTabs.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level(tabModule(tab)) === "view";
  useViewOnlyLock(tabViewOnly, tab);
  const [preset, setPreset] = useState<MessageFilterPreset>({});
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ predicate: isGmailQuery }) > 0;

  // Shortcuts from the Overview into a pre-filtered Messages tab.
  const openMessages = (next: MessageFilterPreset) => {
    setPreset(next);
    setTab("messages");
  };
  const showCategory = (category: GmailCategory) => openMessages({ category });

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <Mail size={22} className="text-red-600" /> Gmail Control
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Monitor every email the HRMS sends through Gmail, and switch each feature on or off
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => queryClient.invalidateQueries({ predicate: isGmailQuery })}
            disabled={fetching}
          >
            <RefreshCw size={13} className={fetching ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="gmail-control-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          <PillTabs className="flex-wrap h-auto" size="sm" items={visibleTabs} value={tab} onChange={setTab} />
        )}

        <ViewOnlyTabNote show={tabViewOnly} />

        {/* the Overview's shortcuts into another tab are only offered when that tab is open to the role */}
        {tab === "overview" && canOpen("overview") && (
          <OverviewTab
            onOpenCategory={canOpen("messages") ? showCategory : undefined}
            onOpenFailures={canOpen("messages") ? () => openMessages({ status: "failed" }) : undefined}
            onOpenConfig={canOpen("config") ? () => setTab("config") : undefined}
          />
        )}
        {tab === "messages" && canOpen("messages") && <MessagesTab preset={preset} />}
        {tab === "employees" && canOpen("employees") && <EmployeesTab />}
        {tab === "controls" && canOpen("controls") && <ControlsTab />}
        {tab === "templates" && canOpen("templates") && <TemplatesTab />}
        {tab === "config" && canOpen("config") && <ConfigTab />}
      </div>
    </HrLayout>
  );
}
