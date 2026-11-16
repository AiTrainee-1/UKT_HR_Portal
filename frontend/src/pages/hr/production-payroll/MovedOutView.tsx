import { useState } from "react";
import { ArrowRight, History, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dateShort, plural } from "@/components/payroll/kit/format";
import { Chip, EmptyNote, PayrollLoader, PaymentChip } from "@/components/payroll/kit/parts";
import { useProductionMovedOut, type PayCycle } from "@/lib/api-client/custom-hooks";
import { PAY_CYCLE_INFO } from "@/lib/api-client/custom-hooks";
import { formatPeriod } from "./logic";
import { movedOutHeadline, movedOutPaid } from "./period-workflow";

/**
 * The "Moved out" view of a cycle page (owner 2026-11-16): the workers who moved FROM this cycle to another one (or off
 * every cycle), with when, who, why, the last period paid here and what this cycle paid them, and a link to that last
 * payroll. A move stays listed for this cycle's next two payroll generations, then only under "Show older".
 */
export function MovedOutView({
  cycle,
  onOpenDetails,
}: {
  cycle: PayCycle;
  onOpenDetails: (payrollId: number) => void;
}) {
  const [older, setOlder] = useState(false);
  const query = useProductionMovedOut(cycle, older);
  const label = PAY_CYCLE_INFO[cycle].label;
  const data = query.data;

  if (query.isLoading) return <PayrollLoader label="Loading the workers who moved out" />;
  if (query.isError || !data) {
    return (
      <EmptyNote
        icon={RefreshCw}
        title="The moved-out workers could not be loaded"
        hint="Check the connection and try again."
        testId="pcp-moved-error"
        action={
          <Button variant="outline" className="mt-2" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const toggle =
    data.olderCount > 0 || older ? (
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => setOlder((v) => !v)}
        data-testid="pcp-moved-older"
      >
        <History size={13} /> {older ? "Show recent only" : `Show older (${data.olderCount})`}
      </Button>
    ) : null;

  return (
    <div className="space-y-3" data-testid="pcp-moved-out">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-600">
          Workers who moved from {label} to another pay cycle (or off every cycle). Each one stays here for the next{" "}
          {plural(data.visibleGenerations, "payroll generation")} of {label} after the move. Days already paid here are
          never paid again by their new cycle.
        </p>
        {toggle}
      </div>
      {data.moves.length === 0 ? (
        <EmptyNote
          icon={LogOut}
          title={older ? `Nobody has moved out of ${label}` : `Nobody moved out of ${label} recently`}
          hint={data.olderCount > 0 ? "Older moves are under Show older." : undefined}
          testId="pcp-moved-empty"
        />
      ) : (
        <ul className="space-y-2">
          {data.moves.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-2 rounded-2xl border border-slate-100 bg-white p-3 sm:flex-row sm:items-start sm:justify-between"
              data-testid={`pcp-moved-row-${row.employeeCode}`}
              data-hidden={row.hidden ? "true" : "false"}
            >
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-gray-900">
                  <span className="break-words">{row.name}</span>
                  <span className="font-mono text-xs font-normal text-muted-foreground">{row.employeeCode}</span>
                  {row.departmentName && (
                    <span className="text-xs font-normal text-gray-500">· {row.departmentName}</span>
                  )}
                  {row.employeeStatus !== "active" && <Chip tone="danger">Inactive</Chip>}
                </p>
                <p className="text-xs font-semibold text-violet-800">{movedOutHeadline(row)}</p>
                {row.reason && (
                  <p className="break-words text-xs text-gray-700">
                    <span className="text-gray-500">Reason:</span> {row.reason}
                  </p>
                )}
                <p className="text-xs text-gray-600">{movedOutPaid(row)}</p>
                {row.paysFrom && row.toCycle && (
                  <p className="text-[11px] text-muted-foreground">
                    {row.toLabel} pays from {dateShort(row.paysFrom)}.
                  </p>
                )}
              </div>
              {row.lastPayroll && (
                <div className="flex shrink-0 flex-col items-start gap-1 text-xs sm:items-end">
                  <span className="text-gray-500">Last period paid here</span>
                  <span className="font-semibold text-gray-800">{formatPeriod(row.lastPayroll)}</span>
                  <PaymentChip status={row.lastPayroll.paymentStatus} />
                  <button
                    type="button"
                    onClick={() => onOpenDetails(row.lastPayroll!.payrollId)}
                    className="inline-flex items-center gap-1 font-semibold text-amber-700 hover:underline"
                    data-testid={`pcp-moved-details-${row.employeeCode}`}
                  >
                    Payroll details <ArrowRight size={12} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
