import { PillTabs } from "@/components/ui/pill-tabs";
import { leavePartOf, type CompensationUrl, type LeavePart } from "../logic";
import { BalancePart } from "./BalancePart";
import { BirthdaysPart } from "./BirthdaysPart";
import { HolidayWorkPart } from "./HolidayWorkPart";
import { WindowsPart } from "./WindowsPart";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

const PART_LABEL: Record<LeavePart, string> = {
  windows: "A. Announce late-in / early-out",
  "holiday-work": "B. Work on Sundays and company holidays",
  birthdays: "C. Birthdays",
};

const PAUSED_MASTER = "Paused: the OT / Compensation features are switched off in Settings → Payroll";

/**
 * Compensation Leave, in three parts that each have their own switch in Settings -> Compensation: A. company-announced
 * late-in / early-out, B. work on Sundays and company holidays (with the compensation balance and its redeem), and
 * C. birthdays. The part is in the address, so a link opens the one you want.
 */
export default function LeaveTab({
  featuresOff,
  isBranchScoped,
  url,
  setUrl,
}: {
  featuresOff: boolean;
  isBranchScoped: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
}) {
  const part: LeavePart = leavePartOf(url.sub);
  return (
    <div className="space-y-4" data-testid="leave-tab">
      <div className="max-w-full overflow-x-auto">
        <PillTabs
          items={(Object.keys(PART_LABEL) as LeavePart[]).map((p) => ({ value: p, label: PART_LABEL[p] }))}
          value={part}
          onChange={(v) => setUrl({ sub: v })}
          baseColor="#4f46e5"
          size="sm"
        />
      </div>

      {part === "windows" && <WindowsPart featuresOff={featuresOff} isBranchScoped={isBranchScoped} />}
      {part === "holiday-work" && (
        <div className="space-y-4">
          <HolidayWorkPart featuresOff={featuresOff} url={url} setUrl={setUrl} />
          <BalancePart paused={featuresOff} pausedReason={PAUSED_MASTER} />
        </div>
      )}
      {part === "birthdays" && <BirthdaysPart url={url} setUrl={setUrl} />}
    </div>
  );
}
