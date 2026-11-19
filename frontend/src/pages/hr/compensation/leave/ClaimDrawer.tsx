import type { ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { ApprovalTrail } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import type { CompensationClaim } from "@/lib/api-client/custom-hooks";
import { DetailDrawer, DrawerFields, DrawerSection, StatusChip } from "@/pages/hr/outpass-visitors/kit";
import { dateLong, dateShort, minutesText, shiftsText } from "../logic";
import { subPath } from "../routes";
import {
  DATE_LABEL,
  STATUS_TONE,
  claimAmountText,
  claimEffectText,
  claimStatusText,
  claimTouchesLedger,
  decisionLine,
  kindText,
  monthOf as monthOfIso,
  raisedByText,
} from "./claims-logic";
import { balanceLink, creditLink } from "./leave-url";

const LINK =
  "inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-indigo-700 underline-offset-2 hover:underline sm:min-h-0";

function GoTo({ href, children, testId }: { href: string; children: ReactNode; testId: string }) {
  return (
    <Link href={href} className={LINK} data-testid={testId}>
      {children}
      <ArrowRight size={14} aria-hidden="true" />
    </Link>
  );
}

/** Where the record a claim is based on lives: the Raise day, the OT list of that month, the birthdays of that month. */
function sourceLink(claim: CompensationClaim): { href: string; label: string } | null {
  const m = monthOfIso(claim.workDate);
  switch (claim.kind) {
    case "holiday_work":
      return {
        href: subPath("leave", "holiday-work", `hdate=${claim.workDate}`, "raise"),
        label: "See who worked that day",
      };
    case "ot_allowance":
    case "ot_shift":
      return m
        ? {
            href: subPath("ot", claim.kind === "ot_allowance" ? "type-1" : "type-2", `month=${m.month}&year=${m.year}`),
            label: `Open OT Detection, ${claim.kind === "ot_allowance" ? "Type 1" : "Type 2"}`,
          }
        : null;
    case "birthday":
      return {
        href: subPath("leave", "birthdays", `bperiod=month&bdate=${claim.workDate}`, "list"),
        label: "Open the birthdays of that month",
      };
    default:
      return null;
  }
}

/** What the claim is based on, in a few label / value pairs. */
function sourceFields(claim: CompensationClaim): { label: string; value: ReactNode; wide?: boolean }[] {
  switch (claim.kind) {
    case "holiday_work":
      return [
        { label: "Worked on", value: dateLong(claim.workDate) },
        {
          label: "Day",
          value: claim.dayKind === "holiday" ? `Holiday${claim.holidayName ? `: ${claim.holidayName}` : ""}` : "Sunday",
        },
      ];
    case "ot_allowance":
    case "ot_shift":
      return [
        { label: "OT date", value: dateLong(claim.overtime?.date || claim.workDate) },
        { label: "Shift end", value: claim.overtime?.shiftEnd },
        {
          label: "Last punch",
          value: claim.overtime?.lastPunch
            ? `${claim.overtime.lastPunch}${claim.overtime.lastPunchNextDay ? " (next day)" : ""}`
            : null,
        },
        { label: "Past the shift end", value: minutesText(claim.overtime?.extraMinutes) },
        claim.kind === "ot_allowance"
          ? { label: "Late-in allowance", value: claim.minutes ? minutesText(claim.minutes) : null }
          : { label: "Shift credit", value: shiftsText(claim.shifts) },
        { label: "OT record", value: claim.overtimeRecordId ? `#${claim.overtimeRecordId}` : null },
      ];
    case "birthday":
      return [
        { label: "Birthday", value: dateLong(claim.workDate) },
        { label: "Credit", value: `${shiftsText(claim.shifts)}: worked on the birthday` },
      ];
    case "use_balance":
      return [
        { label: "Day off on", value: dateLong(claim.useDate ?? claim.workDate) },
        { label: "From the balance", value: shiftsText(claim.shifts) },
      ];
    default:
      return [];
  }
}

/**
 * One claim in full: what it is, what it is based on (the Sunday worked, the OT times, the birthday, the day off asked
 * for), its approval trail with who decided, and what it put on (or took off) the balance, with links to the entry in
 * Credits and to the employee's balance. A claim still waiting can be withdrawn from here.
 */
export function ClaimDrawer({
  claim,
  onClose,
  canWithdraw,
  pausedReason,
  onWithdraw,
}: {
  claim: CompensationClaim | null;
  onClose: () => void;
  canWithdraw: boolean;
  pausedReason: string;
  onWithdraw: (claim: CompensationClaim) => void;
}) {
  const c = claim;
  const source = c ? sourceLink(c) : null;
  const decided = c ? decisionLine(c) : null;
  return (
    <DetailDrawer
      open={c !== null}
      onOpenChange={(open) => !open && onClose()}
      title={c ? c.employeeName : "Claim"}
      subtitle={c ? `${kindText(c)} · ${dateLong(c.workDate)}` : undefined}
      wide
      testId="claim-drawer"
      footer={
        c && (
          <>
            {c.status === "pending" && (
              <Button
                type="button"
                variant="outline"
                className="h-11 sm:h-9"
                disabled={!canWithdraw}
                title={canWithdraw ? "Withdraw and remove this claim from the Department Head's queue" : pausedReason}
                onClick={() => onWithdraw(c)}
                data-testid="claim-drawer-withdraw"
              >
                Withdraw
              </Button>
            )}
            <Button type="button" className="h-11 sm:h-9" onClick={onClose} data-view-safe="">
              Close
            </Button>
          </>
        )
      }
    >
      {c && (
        <>
          <DrawerSection title="The claim" testId="claim-drawer-claim">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={STATUS_TONE[c.status] ?? "slate"}>{claimStatusText(c)}</StatusChip>
              <span className="text-xs text-slate-500">Claim #{c.id}</span>
            </div>
            <DrawerFields
              items={[
                { label: "Kind", value: kindText(c) },
                { label: DATE_LABEL[c.kind], value: dateLong(c.workDate) },
                { label: "Claimed", value: claimAmountText(c) },
                { label: "Raised by", value: raisedByText(c) },
                { label: "Raised on", value: c.createdAt ? dateShort(c.createdAt.slice(0, 10)) : null },
                { label: "Department", value: [c.department, c.branch].filter(Boolean).join(" · ") },
                { label: "Reason", value: c.reason, wide: true },
              ]}
            />
          </DrawerSection>

          <DrawerSection title="Based on" testId="claim-drawer-source">
            <DrawerFields items={sourceFields(c)} />
            {source && (
              <GoTo href={source.href} testId="claim-drawer-source-link">
                {source.label}
              </GoTo>
            )}
          </DrawerSection>

          <DrawerSection title="Approval" testId="claim-drawer-approval">
            {c.approval && (
              <div className="overflow-x-auto pb-1">
                <ApprovalTrail approval={c.approval} submittedBy={c.raisedByRole === "employee" ? "Employee" : "HR"} />
              </div>
            )}
            <p className="text-sm text-slate-700">
              {c.status === "pending"
                ? c.hodName
                  ? `Waiting for ${c.hodName} (Department Head) to decide in Approvals.`
                  : "No Department Head is assigned to this employee, so nobody can decide it yet (HOD Assignment)."
                : decided}
            </p>
            {c.reviewComment && <p className="text-sm italic text-slate-600">“{c.reviewComment}”</p>}
          </DrawerSection>

          <DrawerSection title="Balance" testId="claim-drawer-ledger">
            <p className="text-sm text-slate-700" data-testid="claim-drawer-effect">
              {claimEffectText(c)}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {c.status === "approved" && claimTouchesLedger(c) && (
                <GoTo href={creditLink(c.employeeId, c.id)} testId="claim-drawer-credit-link">
                  {c.kind === "use_balance" ? "See the entry in Credits" : "See the credit in Credits"}
                </GoTo>
              )}
              <GoTo href={balanceLink(c.employeeId)} testId="claim-drawer-balance-link">
                Open the balance of {c.employeeName}
              </GoTo>
            </div>
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}
