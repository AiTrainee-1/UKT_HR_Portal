import { useEffect, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Building2,
  Clock,
  Mail,
  Database,
  IndianRupee,
  FileText,
  Fingerprint,
  CreditCard,
  FileSignature,
  Eye,
  AlertTriangle,
  Factory,
  MessageCircle,
  Palette,
} from "lucide-react";
import { ThemesPanel } from "@/components/ThemesPanel";
import { useAuth, permissionLevel } from "@/contexts/AuthContext";
import { lockMutatingControls } from "@/lib/view-only-lock";
import CompanyTab from "./settings/CompanyTab";
import DevicesTab from "./settings/DevicesTab";
import IdCardTab from "./settings/IdCardTab";
import DocumentsTab from "./settings/DocumentsTab";
import AttendanceTab from "./settings/AttendanceTab";
import LateDetectionTab from "./settings/LateDetectionTab";
import PayrollTab from "./settings/PayrollTab";
import ProductionPayrollTab from "./settings/ProductionPayrollTab";
import SmtpTab from "./settings/SmtpTab";
import WhatsAppTab from "./settings/WhatsAppTab";
import BackupTab from "./settings/BackupTab";
import SalarySlipTab from "./settings/SalarySlipTab";
import { SETTINGS_TAB_MODULE } from "./settings/constants";

export default function Settings() {
  const { user } = useAuth();

  const [settingsTab, setSettingsTab] = useState("company");

  const tabLevel = (tab: string) => permissionLevel(user, SETTINGS_TAB_MODULE[tab] ?? "settings");

  const isTabViewOnly = tabLevel(settingsTab) === "view";

  // Land on the first tab this role can actually see if the default
  // ("company") -or whichever tab was active before a permission change —
  // is hidden for them.
  useEffect(() => {
    if (tabLevel(settingsTab) === "hidden") {
      const firstVisible = Object.keys(SETTINGS_TAB_MODULE).find((t) => tabLevel(t) !== "hidden");
      if (firstVisible) setSettingsTab(firstVisible);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, settingsTab]);

  // Radix Tabs only mounts the active TabsContent, so locking document.body
  // whenever the active tab is view-only (same mechanism HrLayout uses
  // page-wide) only ever touches that one tab's controls.
  useEffect(() => {
    if (!isTabViewOnly) return;
    const relock = () => lockMutatingControls(document.body);
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isTabViewOnly, settingsTab]);

  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Settings</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Configure system, attendance, payroll, and notification settings
          </p>
        </div>

        <Tabs value={settingsTab} onValueChange={setSettingsTab}>
          <PillTabs
            className="flex-wrap h-auto"
            items={[
              { value: "company", label: "Company", icon: <Building2 size={13} /> },
              { value: "attendance", label: "Attendance", icon: <Clock size={13} /> },
              { value: "late_detection", label: "Late Detection", icon: <AlertTriangle size={13} /> },
              { value: "devices", label: "Devices", icon: <Fingerprint size={13} /> },
              { value: "idcard", label: "ID Card", icon: <CreditCard size={13} /> },
              { value: "documents", label: "Company Documents", icon: <FileSignature size={13} /> },
              { value: "payroll", label: "Payroll", icon: <IndianRupee size={13} /> },
              { value: "production_payroll", label: "Production Payroll", icon: <Factory size={13} /> },
              { value: "salary-slip", label: "Salary Slip", icon: <FileText size={13} /> },
              { value: "smtp", label: "SMTP / Email", icon: <Mail size={13} /> },
              { value: "whatsapp", label: "WhatsApp", icon: <MessageCircle size={13} /> },
              { value: "backup", label: "Backup", icon: <Database size={13} /> },
              { value: "themes", label: "Themes", icon: <Palette size={13} /> },
            ].filter((t) => tabLevel(t.value) !== "hidden")}
            value={settingsTab}
            onChange={setSettingsTab}
            size="sm"
          />

          {isTabViewOnly && (
            <div
              className="flex items-center gap-2 mt-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold"
              style={{
                background: "rgba(245,158,11,0.08)",
                color: "#b45309",
                boxShadow: "inset 3px 3px 8px rgba(245,158,11,0.06), inset -3px -3px 8px rgba(255,255,255,0.9)",
              }}
            >
              <Eye size={15} strokeWidth={2} />
              View only -browse and inspect freely, changes can't be saved.
            </div>
          )}

          {/* Company */}

          <TabsContent value="company" className="mt-4">
            <CompanyTab />
          </TabsContent>

          <TabsContent value="devices" className="mt-4">
            <DevicesTab />
          </TabsContent>

          <TabsContent value="idcard" className="mt-4">
            <IdCardTab />
          </TabsContent>

          <TabsContent value="documents" className="mt-4 space-y-4">
            <DocumentsTab />
          </TabsContent>

          <TabsContent value="attendance" className="mt-4 space-y-4">
            <AttendanceTab />
          </TabsContent>

          <TabsContent value="late_detection" className="mt-4 space-y-4">
            <LateDetectionTab />
          </TabsContent>

          <TabsContent value="payroll" className="mt-4 space-y-4">
            <PayrollTab />
          </TabsContent>

          <TabsContent value="production_payroll" className="mt-4 space-y-4">
            <ProductionPayrollTab />
          </TabsContent>

          <TabsContent value="smtp" className="mt-4">
            <SmtpTab />
          </TabsContent>

          <TabsContent value="whatsapp" className="mt-4">
            <WhatsAppTab />
          </TabsContent>

          <TabsContent value="backup" className="mt-4 space-y-4">
            <BackupTab />
          </TabsContent>

          <TabsContent value="salary-slip" className="mt-4">
            <SalarySlipTab />
          </TabsContent>

          <TabsContent value="themes" className="mt-4">
            <ThemesPanel readOnly={isTabViewOnly} />
          </TabsContent>
        </Tabs>
      </div>
    </HrLayout>
  );
}
