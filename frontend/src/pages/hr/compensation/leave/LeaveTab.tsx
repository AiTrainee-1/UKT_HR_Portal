import { SubtabBar } from "@/components/ui/subtab-nav";
import { LEAVE_SUBS, LEAVE_SUB_LABEL, pagePath, subPath, type LeaveSub } from "../routes";
import { openDefaultNested, useCanOpen } from "../visible";
import { BirthdaysPart } from "./BirthdaysPart";
import { HolidayWorkPart } from "./HolidayWorkPart";
import { LEAVE_OWN_KEYS } from "./leave-url";
import { WindowsPart } from "./WindowsPart";

const LEAVE_BASE = pagePath("leave");

/**
 * Compensation Leave, in three subtabs that each have their own switch in Settings -> Compensation: A. company-announced
 * late-in / early-out, B. the compensation claim workflow (Sunday and holiday work raised here, the claims of every kind,
 * the balances and their credits), and C. birthdays. The subtab is the path, so a link opens the one you want. Each subtab
 * shows one section at a time, as nested subtabs (also in the path): A. Announce / Announcements, B. Raise a claim / Claims /
 * Balance / Credits, C. Who has a birthday / How it works. Their filters live in the address (leave-url.ts).
 */
export default function LeaveTab({
  sub,
  nested,
  featuresOff,
  isBranchScoped,
}: {
  sub: LeaveSub;
  /** The nested subtab of `sub` (the page redirects a missing or unknown one to the first before this renders). */
  nested: string;
  featuresOff: boolean;
  isBranchScoped: boolean;
}) {
  const canOpen = useCanOpen();
  return (
    <div className="space-y-4" data-testid="leave-tab">
      <SubtabBar
        base={LEAVE_BASE}
        value={sub}
        testId="leave-subtabs"
        items={LEAVE_SUBS.filter((p) => p === sub || canOpen(subPath("leave", p))).map((p) => ({
          value: p,
          label: LEAVE_SUB_LABEL[p],
        }))}
        landing={(next) => openDefaultNested(canOpen, "leave", next)}
        ownKeys={LEAVE_OWN_KEYS}
      />

      {sub === "announcements" && (
        <WindowsPart featuresOff={featuresOff} isBranchScoped={isBranchScoped} nested={nested} />
      )}
      {sub === "holiday-work" && <HolidayWorkPart featuresOff={featuresOff} nested={nested} />}
      {sub === "birthdays" && <BirthdaysPart nested={nested} />}
    </div>
  );
}
