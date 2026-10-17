import { CalendarPlus } from "lucide-react";
import { ToFirstSubtab, useSubtab } from "@/components/ui/subtab-nav";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { useAuth } from "@/contexts/AuthContext";
import {
  CompensationPageShell,
  ToDefaultNested,
  useCompensationFeaturesOff,
  useNestedSubtab,
} from "../CompensationPageShell";
import LeaveTab from "../leave/LeaveTab";
import { COMPENSATION_URL_DEFAULTS } from "../logic";
import { LEAVE_SUBS, pagePath, type LeaveSub } from "../routes";

const BASE = pagePath("leave");

function CompensationLeave({ sub, nested }: { sub: LeaveSub; nested: string }) {
  const { user } = useAuth();
  const [url, setUrl] = useUrlParams(COMPENSATION_URL_DEFAULTS);
  const featuresOff = useCompensationFeaturesOff();
  return (
    <CompensationPageShell
      icon={<CalendarPlus size={20} className="text-teal-600" />}
      title="Compensation Leave"
      description="Late-in and early-out announced for everyone, work on Sundays and company holidays with the compensation balance, and birthdays."
    >
      <LeaveTab
        sub={sub}
        nested={nested}
        featuresOff={featuresOff}
        isBranchScoped={!!user?.branchId}
        url={url}
        setUrl={setUrl}
      />
    </CompensationPageShell>
  );
}

/**
 * Compensation > Compensation Leave, with a subtab each for A. announcements, B. Sunday and holiday work, C. birthdays, and a
 * nested subtab per section of each (/announcements/announce, /holiday-work/claims, /birthdays/list, ...).
 */
export default function CompensationLeavePage() {
  const sub = useSubtab(BASE, LEAVE_SUBS);
  const nested = useNestedSubtab("leave", sub);
  if (!sub) return <ToFirstSubtab base={BASE} first={LEAVE_SUBS[0]} />;
  if (!nested) return <ToDefaultNested pageKey="leave" sub={sub} />;
  return <CompensationLeave sub={sub} nested={nested} />;
}
