import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Moon, Send } from "lucide-react";
import { EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import { FilterSelect } from "@/components/payroll/panels/issues/panel-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { OvertimeRow } from "@/lib/api-client/custom-hooks";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import { compensationSettingsHref, dateShort, minutesText } from "../logic";
import { CELL, Notice, PersonCell, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import { ClaimDialog } from "./ClaimDialog";
import { ClaimCell, LastPunch } from "./parts";
import { AllowanceRules } from "./RulesExplain";
import { TYPE1_STATUSES, canClaim, inClaimFlow, rowKey, type1State, type Pause } from "./ot-logic";

/**
 * Type 1: the next-day late-in allowance. From the claims date it is no longer automatic: each detected allowance is listed
 * as claimable until the employee (in the apps) or HR (here, "Claim for employee") claims it; the employee's Department
 * Head approves, and only then is it applied to the next working day after the OT date. An allowance nobody claims stays
 * here as a record. Days before the claims date were automatic and show whether they were used. (How it is worked out is
 * the other nested subtab: <Type1How>.)
 */
export function Type1Section({
  rows,
  total,
  loading,
  off,
  claimsFrom,
  pause,
  status,
  onStatus,
}: {
  /** The rows the filters leave. */
  rows: OvertimeRow[];
  /** All of the month's Type 1 rows (so an empty result can say whether a filter hid them). */
  total: number;
  loading: boolean;
  /** Type 1 is switched off in Settings (the master switch is on). */
  off: boolean;
  /** The claim workflow's start date (null: not known, an older server). */
  claimsFrom: string | null;
  /** Why claiming is paused right now, or null. */
  pause: Pause;
  /** The status filter (`ot1status`), "all" for every row. */
  status: string;
  onStatus: (value: string) => void;
}) {
  const paged = usePaged(rows, `t1|${status}|${rows.length}`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [claiming, setClaiming] = useState<OvertimeRow[] | null>(null);

  const claimable = useMemo(() => rows.filter(canClaim), [rows]);
  const chosen = useMemo(() => claimable.filter((r) => selected.has(rowKey(r))), [claimable, selected]);
  const anyClaimFlow = useMemo(() => rows.some((r) => inClaimFlow(r, claimsFrom)), [rows, claimsFrom]);
  const showSelect = claimable.length > 0;
  const allOn = claimable.length > 0 && chosen.length === claimable.length;

  const toggle = (key: string) =>
    setSelected((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(claimable.map(rowKey)));
  const afterClaim = (keys: string[]) =>
    setSelected((set) => {
      const next = new Set(set);
      for (const key of keys) next.delete(key);
      return next;
    });

  const description = claimsFrom
    ? `Unpaid. From ${dateShort(claimsFrom)} an allowance is given only after a claim (by the employee in the app, or by HR here) is approved by the employee's Department Head; it then applies to the next working day. Unclaimed allowances stay listed. Earlier days were automatic.`
    : "Unpaid. Staff who work past their shift end may arrive later the next working morning, by the allowance in each row, once a claim for it is approved by their Department Head.";

  return (
    <SectionCard
      testId="ot-type1"
      icon={Moon}
      title="Type 1 · Next-day late-in allowance"
      description={description}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            value={status === "all" ? "" : status}
            onChange={(v) => onStatus(v === "" ? "all" : v)}
            options={TYPE1_STATUSES.map((s) => ({ value: s.value, label: s.label }))}
            allLabel="Every status"
            label="Filter by status"
            testId="ot1-status"
            className="h-9 w-48"
          />
          <StatusChip tone="accent">Claim · HOD approves</StatusChip>
        </div>
      }
      bodyClassName="space-y-3 px-0 pb-0"
    >
      {showSelect && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-5">
          <p className="text-xs text-muted-foreground">
            {claimable.length === 1 ? "1 allowance" : `${claimable.length} allowances`} can be claimed. Tick the ones to
            claim for the employees, or use Claim on a row.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground" data-testid="ot1-selected">
              {chosen.length} selected
            </span>
            <Button
              type="button"
              size="sm"
              disabled={!!pause || chosen.length === 0}
              title={pause?.reason ?? "Send claims for the ticked allowances to the employees' Department Heads"}
              onClick={() => setClaiming(chosen)}
              data-testid="ot1-claim"
            >
              <Send size={13} className="mr-1.5" />
              Claim for employee{chosen.length > 0 ? ` (${chosen.length})` : ""}
            </Button>
          </div>
        </div>
      )}
      {pause?.setting && showSelect && (
        <p className="px-5 text-xs text-muted-foreground" data-testid="ot1-pause">
          {pause.reason}.{" "}
          <Link href={compensationSettingsHref(pause.setting)} className="font-semibold text-blue-700 hover:underline">
            Open the setting
          </Link>
        </p>
      )}

      {loading ? (
        <div className="px-5 pb-5 text-sm text-muted-foreground" data-testid="ot-type1-loading">
          Loading the month&apos;s records…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyNote
            icon={Moon}
            title={total > 0 ? "No Type 1 record matches these filters" : "No allowance earned in this month"}
            hint={
              total > 0
                ? "Change the status, the search or the department to see the others."
                : off
                  ? "Type 1 is switched off in Settings, so no allowance is detected."
                  : "It appears here when somebody works past their shift end by the first rule's time."
            }
            testId="ot-type1-empty"
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm" data-testid="ot-type1-table">
              <thead className={TABLE_HEAD}>
                <tr>
                  {showSelect && (
                    <th className="w-10 px-3 py-2.5 pl-5">
                      <Checkbox
                        checked={allOn}
                        onCheckedChange={toggleAll}
                        aria-label="Select every claimable allowance in the list"
                        data-testid="ot1-select-all"
                      />
                    </th>
                  )}
                  <th className={`px-3 py-2.5 ${showSelect ? "" : "pl-5"}`}>Employee</th>
                  <th className="px-3 py-2.5">OT date</th>
                  <th className="px-3 py-2.5">Shift end</th>
                  <th className="px-3 py-2.5">Last punch</th>
                  <th className="px-3 py-2.5">Extra time</th>
                  <th className="px-3 py-2.5">Allowance</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Claim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map((row) => {
                  const state = type1State(row, claimsFrom);
                  const id = `${row.employeeCode}-${row.date}`;
                  const can = canClaim(row);
                  return (
                    <tr
                      key={row.id}
                      className={selected.has(rowKey(row)) && can ? "bg-indigo-50/50" : undefined}
                      data-testid={`ot-type1-row-${id}`}
                    >
                      {showSelect && (
                        <td className={`${CELL} pl-5`}>
                          {can && (
                            <Checkbox
                              checked={selected.has(rowKey(row))}
                              onCheckedChange={() => toggle(rowKey(row))}
                              aria-label={`Select ${row.employeeName}, ${dateShort(row.date)}`}
                              data-testid={`ot1-select-${id}`}
                            />
                          )}
                        </td>
                      )}
                      <td className={`${CELL} ${showSelect ? "" : "pl-5"}`}>
                        <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                      </td>
                      <td className={`${CELL} whitespace-nowrap`}>{dateShort(row.date)}</td>
                      <td className={`${CELL} text-gray-600`}>{row.shiftEndTime ?? "—"}</td>
                      <td className={`${CELL} whitespace-nowrap text-gray-600`}>
                        <LastPunch row={row} />
                      </td>
                      <td className={`${CELL} whitespace-nowrap font-semibold text-amber-700`}>
                        {formatDuration(row.otMinutes)}
                      </td>
                      <td className={`${CELL} whitespace-nowrap font-semibold`}>{minutesText(row.allowanceMinutes)}</td>
                      <td className={CELL}>
                        <span data-testid={`ot-type1-use-${id}`} data-status={state.status}>
                          <StatusChip tone={state.tone} title={state.title}>
                            {state.text}
                          </StatusChip>
                        </span>
                      </td>
                      <td className={CELL}>
                        {row.claim ? (
                          <ClaimCell claim={row.claim} employeeId={row.employeeId} testId={`ot-type1-claim-${id}`} />
                        ) : null}
                        {can && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={row.claim ? "mt-1.5 h-8" : "h-8"}
                            disabled={!!pause}
                            title={
                              pause?.reason ??
                              `Send a claim for this allowance of ${row.employeeName} to the Department Head`
                            }
                            onClick={() => setClaiming([row])}
                            data-testid={`ot1-claim-${id}`}
                          >
                            Claim
                          </Button>
                        )}
                        {!row.claim && !can && (
                          <span className="text-xs text-muted-foreground">
                            {inClaimFlow(row, claimsFrom) ? "—" : "Automatic"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager paged={paged} />
        </>
      )}

      {!loading && anyClaimFlow && claimable.length === 0 && rows.length > 0 && (
        <div className="px-5 pb-4">
          <Notice accent="slate" testId="ot1-nothing-to-claim">
            <p>Nothing on this page can be claimed now: every allowance is claimed, decided or too old to claim.</p>
          </Notice>
        </div>
      )}

      <ClaimDialog
        open={claiming !== null}
        onOpenChange={(open) => !open && setClaiming(null)}
        kind="ot_allowance"
        rows={claiming ?? []}
        onClaimed={afterClaim}
      />
    </SectionCard>
  );
}

/** Type 1, how it is worked out: the claim workflow and the rules the page is using now (read from Settings). */
export function Type1How({ claimsFrom }: { claimsFrom: string | null }) {
  return (
    <SectionCard
      testId="ot-type1-how"
      icon={Moon}
      title="How the late-in allowance is worked out"
      description="Read-only: the rules are set in Settings → Compensation."
      bodyClassName="space-y-3"
    >
      <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-gray-600" data-testid="ot1-how-steps">
        <li>
          <strong>Detected.</strong> A staff member works past the shift end. The allowance comes from the table below
          (more extra work than where Type 2 starts is Type 2&apos;s).
        </li>
        <li>
          <strong>Claimed.</strong> The employee claims it in the mobile app or on the web, or HR claims it here with
          Claim for employee. Nothing is given before a claim.
        </li>
        <li>
          <strong>Approved by the Department Head.</strong> Only an approved claim counts. A rejected one gives nothing.
        </li>
        <li>
          <strong>Applied to the next working day after the OT date.</strong> If the employee arrives late{" "}
          <strong>within</strong> the allowance, the morning is not marked Late: attendance marks it as{" "}
          <strong>Compensation</strong> instead. Arriving on time leaves it unused. Whether to use it is the
          employee&apos;s choice, and it is never paid.
        </li>
      </ol>
      <p className="text-xs leading-relaxed text-gray-600" data-testid="ot1-how-before">
        {claimsFrom
          ? `This applies from ${dateShort(claimsFrom)}. Allowances earned before that were automatic: they applied to the next working day without a claim, and stay as they were.`
          : "Allowances earned before the claim workflow started were automatic: they applied to the next working day without a claim, and stay as they were."}{" "}
        An allowance that is approved after its day has passed corrects that day&apos;s attendance, unless the day was
        edited by hand or its payroll month is locked (the approval is then refused with the reason).
      </p>
      <AllowanceRules defaultOpen />
    </SectionCard>
  );
}
