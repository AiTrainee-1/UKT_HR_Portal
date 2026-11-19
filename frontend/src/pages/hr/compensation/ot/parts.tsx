import { Link } from "wouter";
import { ArrowUpRight, MoonStar } from "lucide-react";
import type { OvertimeClaim, OvertimeRow } from "@/lib/api-client/custom-hooks";
import { StatusChip } from "../ui";
import { claimChip, claimHref, raisedByText } from "./ot-logic";

// Small cells the Type 1 and Type 2 tables share: the last punch (a punch on the next morning says so in words, not only by
// a colour) and the claim of a record with a link to it in the Claims list.

/** "19:30", or "02:10" with a "next day" tag: a next-morning punch before the cut-off ends the OT day. */
export function LastPunch({ row }: { row: Pick<OvertimeRow, "lastPunchOut" | "lastPunchNextDay"> }) {
  if (!row.lastPunchOut) return <span>—</span>;
  if (!row.lastPunchNextDay) return <span className="tabular-nums">{row.lastPunchOut}</span>;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1"
      title="A punch on the next morning, before the next-morning cut-off: it ends the OT day, so it is counted as that day's overtime."
    >
      <span className="font-semibold tabular-nums text-gray-900">{row.lastPunchOut}</span>{" "}
      <span className="inline-flex items-center gap-0.5 rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-indigo-800">
        <MoonStar size={10} aria-hidden="true" />
        next day
      </span>
    </span>
  );
}

/** A record's claim: its status chip, who raised it, and a link to it in the Claims list. */
export function ClaimCell({
  claim,
  employeeId,
  testId,
}: {
  claim: OvertimeClaim;
  employeeId: number;
  testId?: string;
}) {
  const chip = claimChip(claim);
  return (
    <div className="space-y-1" data-testid={testId} data-status={claim.status}>
      <StatusChip tone={chip.tone} title={chip.title}>
        {chip.text}
      </StatusChip>
      <p className="text-[11px] text-muted-foreground">
        Raised {raisedByText(claim)} ·{" "}
        <Link
          href={claimHref(claim, employeeId)}
          className="inline-flex items-center gap-0.5 font-semibold text-blue-700 hover:underline"
          aria-label={`Claim #${claim.id}: open it in the Claims list`}
        >
          Claim #{claim.id}
          <ArrowUpRight size={11} aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}
