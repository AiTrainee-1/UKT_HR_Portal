import { Moon } from "lucide-react";
import { EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import type { OvertimeRow } from "@/lib/api-client/custom-hooks";
import { CELL, PersonCell, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import { dateShort, minutesText } from "../logic";
import { allowanceUseText, lastPunchText } from "./ot-logic";
import { AllowanceRules } from "./RulesExplain";
import { formatDuration } from "@/pages/hr/settings/compensation/time";

const USE_TONE = { used: "success", not_used: "neutral", pending: "info" } as const;
const USE_TITLE = {
  used: "The employee arrived late within the allowance: that morning is marked Compensation.",
  not_used: "The next working day has come and the employee did not need the allowance.",
  pending: "The employee's next working day is today or later, so it cannot be said yet whether the allowance is used.",
} as const;

/**
 * Type 1: the automatic next-day late-in allowance. Read-only on purpose: nobody assigns or claims it. A row says who worked
 * past the shift end, for how long, the allowance the next working morning may use, and whether the employee used it.
 */
export function Type1Section({
  rows,
  total,
  loading,
  off,
}: {
  /** The rows the filters leave. */
  rows: OvertimeRow[];
  /** All of the month's Type 1 rows (so an empty result can say whether a filter hid them). */
  total: number;
  loading: boolean;
  /** Type 1 is switched off in Settings (the master switch is on). */
  off: boolean;
}) {
  const paged = usePaged(rows, `t1|${rows.length}`);
  return (
    <SectionCard
      testId="ot-type1"
      icon={Moon}
      title="Type 1 · Next-day late-in allowance"
      description="Automatic and unpaid. Staff who work past their shift end may arrive later the next working morning, by the allowance below. There is nothing to assign or claim."
      actions={<StatusChip tone="neutral">Automatic · read-only</StatusChip>}
      bodyClassName="space-y-3 px-0 pb-0"
    >
      <div className="space-y-3 px-5">
        <p className="text-xs leading-relaxed text-gray-600">
          If the employee arrives late <strong>within</strong> the allowance, the morning is not detected as Late:
          attendance marks it as <strong>Compensation</strong> instead. Arriving on time leaves the allowance unused and
          nothing is marked. Whether to use it is the employee&apos;s choice.
        </p>
        <AllowanceRules />
      </div>

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
                ? "Change the search or the department to see the others."
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
            <table className="w-full min-w-[820px] text-sm" data-testid="ot-type1-table">
              <thead className={TABLE_HEAD}>
                <tr>
                  <th className="px-3 py-2.5 pl-5">Employee</th>
                  <th className="px-3 py-2.5">OT date</th>
                  <th className="px-3 py-2.5">Shift end</th>
                  <th className="px-3 py-2.5">Last punch</th>
                  <th className="px-3 py-2.5">Extra time</th>
                  <th className="px-3 py-2.5">Allowance</th>
                  <th className="px-3 py-2.5">Used?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map((row) => {
                  const use = allowanceUseText(row);
                  return (
                    <tr key={row.id} data-testid={`ot-type1-row-${row.employeeCode}-${row.date}`}>
                      <td className={`${CELL} pl-5`}>
                        <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                      </td>
                      <td className={`${CELL} whitespace-nowrap`}>{dateShort(row.date)}</td>
                      <td className={`${CELL} text-gray-600`}>{row.shiftEndTime ?? "—"}</td>
                      <td className={`${CELL} whitespace-nowrap text-gray-600`}>{lastPunchText(row)}</td>
                      <td className={`${CELL} whitespace-nowrap font-semibold text-amber-700`}>
                        {formatDuration(row.otMinutes)}
                      </td>
                      <td className={`${CELL} whitespace-nowrap font-semibold`}>{minutesText(row.allowanceMinutes)}</td>
                      <td className={CELL}>
                        <span data-testid={`ot-type1-use-${row.employeeCode}-${row.date}`} data-status={use.status}>
                          <StatusChip tone={USE_TONE[use.status]} title={USE_TITLE[use.status]}>
                            {use.text}
                          </StatusChip>
                        </span>
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
    </SectionCard>
  );
}
