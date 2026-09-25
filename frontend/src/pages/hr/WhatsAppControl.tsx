import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  FileText,
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
import MessagesTab, { type MessageFilterPreset } from "./whatsapp-control/MessagesTab";
import OverviewTab from "./whatsapp-control/OverviewTab";
import TemplatesTab from "./whatsapp-control/TemplatesTab";

const TABS = [
  { value: "overview", label: "Overview", icon: <BarChart3 size={13} /> },
  { value: "messages", label: "Messages", icon: <ListChecks size={13} /> },
  { value: "employees", label: "Employees", icon: <Users size={13} /> },
  { value: "controls", label: "Feature Controls", icon: <SlidersHorizontal size={13} /> },
  { value: "templates", label: "Message Text", icon: <FileText size={13} /> },
  { value: "config", label: "Configuration", icon: <Settings2 size={13} /> },
];

export default function WhatsAppControl() {
  const [tab, setTab] = useState("overview");
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

        <PillTabs className="flex-wrap h-auto" size="sm" items={TABS} value={tab} onChange={setTab} />

        {tab === "overview" && (
          <OverviewTab
            onOpenCategory={showCategory}
            onOpenFailures={() => openMessages({ status: "failed" })}
            onOpenConfig={() => setTab("config")}
          />
        )}
        {tab === "messages" && <MessagesTab preset={preset} />}
        {tab === "employees" && <EmployeesTab />}
        {tab === "controls" && <ControlsTab />}
        {tab === "templates" && <TemplatesTab />}
        {tab === "config" && <ConfigTab />}
      </div>
    </HrLayout>
  );
}
