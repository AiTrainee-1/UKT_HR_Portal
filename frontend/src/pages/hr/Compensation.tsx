import { Link } from "wouter";
import { CalendarPlus, Clock, History, Landmark, PauseCircle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useAuth } from "@/contexts/AuthContext";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import CtcBreakdownTab from "./compensation/CtcBreakdownTab";
import HistoryTab from "./compensation/history/HistoryTab";
import LeaveTab from "./compensation/leave/LeaveTab";
import { COMPENSATION_URL_DEFAULTS, isCompensationTab, type CompensationTab } from "./compensation/logic";
import OtTab from "./compensation/ot/OtTab";

/**
 * Compensation: CTC Breakdown, OT Detection, Compensation Leave and History & Reports (the folder `compensation/` holds the
 * four tabs). The tab and every filter live in the address, so a reload or a shared link lands on the same screen.
 */
export default function Compensation() {
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;
  const [url, setUrl] = useUrlParams(COMPENSATION_URL_DEFAULTS);
  const tab: CompensationTab = isCompensationTab(url.tab) ? url.tab : "ctc";
  const { data: payrollSettingsData } = usePayrollSettings();
  // The page itself is mandatory and never hidden. The Settings switch only turns the background OT / Compensation
  // features off (detection, OT pay in payroll, announced windows, birthday leave, claims), so with it off everything stays
  // readable and only the changes that would have no effect are paused. "Not loaded yet" counts as on, so the
  // notice doesn't flash before Settings has come back.
  const featuresOff = payrollSettingsData?.compensationFeatureEnabled === false;

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black flex items-center gap-2">
            <Landmark size={20} className="text-teal-600" /> Compensation
          </h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            CTC breakdown, OT detection, Compensation Leave and who benefited from each: staff employees only, all
            HR-controlled.
          </p>
        </div>

        {featuresOff && (
          <div
            className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900"
            role="status"
            data-testid="compensation-features-off"
          >
            <PauseCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="leading-relaxed">
              <strong>The OT and Compensation features are switched off.</strong> This page and every record on it stay
              available, but OT is not being detected, assigned OT no longer adds pay to payslips, announced late-in /
              early-out, birthday leave and the next-day allowance do not act, and assigning OT, announcing, raising
              Sunday / holiday claims and redeeming the balance are paused until they are switched back on in{" "}
              <Link href="/hr/settings?tab=payroll#compensation-features" className="font-semibold underline">
                Settings → Payroll → OT / Compensation
              </Link>
              . Nothing is deleted while they are off.
            </p>
          </div>
        )}

        <div className="max-w-full overflow-x-auto">
          <PillTabs
            items={[
              { value: "ctc", label: "CTC Breakdown", icon: <Landmark size={13} /> },
              { value: "ot", label: "OT Detection", icon: <Clock size={13} /> },
              { value: "leave", label: "Compensation Leave", icon: <CalendarPlus size={13} /> },
              { value: "history", label: "History & Reports", icon: <History size={13} /> },
            ]}
            value={tab}
            onChange={(v) => setUrl({ tab: v })}
            baseColor="#0f172a"
            pillBg="#f1f5f9"
          />
        </div>

        {tab === "ctc" && <CtcBreakdownTab isBranchScoped={isBranchScoped} />}
        {tab === "ot" && <OtTab featuresOff={featuresOff} url={url} setUrl={setUrl} />}
        {tab === "leave" && (
          <LeaveTab featuresOff={featuresOff} isBranchScoped={isBranchScoped} url={url} setUrl={setUrl} />
        )}
        {tab === "history" && (
          <HistoryTab featuresOff={featuresOff} isBranchScoped={isBranchScoped} url={url} setUrl={setUrl} />
        )}
      </div>
    </HrLayout>
  );
}
