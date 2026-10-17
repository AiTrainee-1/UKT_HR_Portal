import { SubtabBar } from "@/components/ui/subtab-nav";
import type { CompensationUrl } from "../logic";
import { LEAVE_SUBS, LEAVE_SUB_LABEL, nestedOf, pagePath, type LeaveSub } from "../routes";
import { BirthdaysPart } from "./BirthdaysPart";
import { HolidayWorkPart } from "./HolidayWorkPart";
import { WindowsPart } from "./WindowsPart";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

const LEAVE_BASE = pagePath("leave");

/**
 * Compensation Leave, in three subtabs that each have their own switch in Settings -> Compensation: A. company-announced
 * late-in / early-out, B. work on Sundays and company holidays (with the compensation balance and its redeem), and
 * C. birthdays. The subtab is the path, so a link opens the one you want. Each subtab shows one section at a time, as nested
 * subtabs (also in the path): A. Announce / Announcements, B. Raise a claim / Claims / Compensation balance / Earlier
 * Alternative-Day credits, C. Who has a birthday / How it works.
 */
export default function LeaveTab({
  sub,
  nested,
  featuresOff,
  isBranchScoped,
  url,
  setUrl,
}: {
  sub: LeaveSub;
  /** The nested subtab of `sub` (the page redirects a missing or unknown one to the first before this renders). */
  nested: string;
  featuresOff: boolean;
  isBranchScoped: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
}) {
  return (
    <div className="space-y-4" data-testid="leave-tab">
      <SubtabBar
        base={LEAVE_BASE}
        value={sub}
        testId="leave-subtabs"
        items={LEAVE_SUBS.map((p) => ({ value: p, label: LEAVE_SUB_LABEL[p] }))}
        landing={(next) => nestedOf("leave", next)[0]?.value}
      />

      {sub === "announcements" && (
        <WindowsPart featuresOff={featuresOff} isBranchScoped={isBranchScoped} nested={nested} />
      )}
      {sub === "holiday-work" && (
        <HolidayWorkPart featuresOff={featuresOff} url={url} setUrl={setUrl} nested={nested} />
      )}
      {sub === "birthdays" && <BirthdaysPart url={url} setUrl={setUrl} nested={nested} />}
    </div>
  );
}
