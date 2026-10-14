import { useMemo, useState } from "react";
import { Archive } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  useAnnounceOvertime,
  useRejectOvertime,
  type OvertimeMode,
  type OvertimeRow,
} from "@/lib/api-client/custom-hooks";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import { dateShort, errorMessage } from "../logic";
import { CELL, PersonCell, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import { assignedText, lastPunchText, rowKey } from "./ot-logic";

/**
 * Records made before the new OT rules keep their OLD meaning: an announced one is one day's pay or one Alternative-Day
 * credit. A still-waiting old record can be announced under that meaning or rejected, so none is left stuck. New detections
 * never land here: they are Type 1 or Type 2.
 */
export function LegacySection({
  rows,
  paused,
  pauseReason,
}: {
  rows: OvertimeRow[];
  paused: boolean;
  pauseReason: string;
}) {
  const { toast } = useToast();
  const announce = useAnnounceOvertime();
  const reject = useRejectOvertime();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const paged = usePaged(rows, `legacy|${rows.length}`);
  const chosen = useMemo(
    () => rows.filter((r) => r.status === "detected" && selected.has(rowKey(r))),
    [rows, selected],
  );
  const busy = announce.isPending || reject.isPending;
  const records = chosen.map((r) => ({ employeeId: r.employeeId, date: r.date }));

  if (rows.length === 0) return null;

  const toggle = (key: string) =>
    setSelected((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const announceAs = async (compensationType: OvertimeMode) => {
    try {
      const res = await announce.mutateAsync({ records, compensationType });
      toast({
        title: `Announced ${res.announced} ${res.announced === 1 ? "record" : "records"} as ${compensationType === "pay" ? "Pay" : "Relaxation"}`,
      });
      setSelected(new Set());
    } catch (err) {
      toast({ title: "Could not announce", description: errorMessage(err, "Try again."), variant: "destructive" });
    }
  };

  const rejectChosen = async () => {
    try {
      const res = await reject.mutateAsync({ records });
      toast({ title: `Rejected ${res.rejected} ${res.rejected === 1 ? "record" : "records"}` });
      setSelected(new Set());
    } catch (err) {
      toast({ title: "Could not reject", description: errorMessage(err, "Try again."), variant: "destructive" });
    }
  };

  const off = paused || chosen.length === 0 || busy;
  return (
    <SectionCard
      testId="ot-legacy"
      icon={Archive}
      title="Earlier records (before the new OT rules)"
      description="These keep their old meaning: Pay is one day's pay, Relaxation is one Alternative-Day credit. New overtime is Type 1 or Type 2 above."
      bodyClassName="space-y-3 px-0 pb-0"
      actions={
        rows.some((r) => r.status === "detected") ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{chosen.length} selected</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={off}
              title={paused ? pauseReason : "Announce as Pay: assign one day's pay for each selected older record"}
              onClick={() => void announceAs("pay")}
              data-testid="ot-legacy-pay"
            >
              Announce as Pay
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={off}
              title={
                paused
                  ? pauseReason
                  : "Announce as Relaxation: assign one Alternative-Day credit for each selected older record"
              }
              onClick={() => void announceAs("relaxation")}
              data-testid="ot-legacy-relaxation"
            >
              Announce as Relaxation
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-rose-600"
              disabled={off}
              title={paused ? pauseReason : "Reject the selected older records"}
              onClick={() => void rejectChosen()}
              data-testid="ot-legacy-reject"
            >
              Reject
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm" data-testid="ot-legacy-table">
          <thead className={TABLE_HEAD}>
            <tr>
              <th className="w-10 px-3 py-2.5 pl-5" />
              <th className="px-3 py-2.5">Employee</th>
              <th className="px-3 py-2.5">OT date</th>
              <th className="px-3 py-2.5">Last punch</th>
              <th className="px-3 py-2.5">Extra time</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Given as</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paged.rows.map((row) => (
              <tr key={row.id} data-testid={`ot-legacy-row-${row.employeeCode}-${row.date}`}>
                <td className={`${CELL} pl-5`}>
                  {row.status === "detected" && (
                    <Checkbox
                      checked={selected.has(rowKey(row))}
                      onCheckedChange={() => toggle(rowKey(row))}
                      aria-label={`Select ${row.employeeName}, ${dateShort(row.date)}`}
                    />
                  )}
                </td>
                <td className={CELL}>
                  <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                </td>
                <td className={`${CELL} whitespace-nowrap`}>{dateShort(row.date)}</td>
                <td className={`${CELL} whitespace-nowrap text-gray-600`}>{lastPunchText(row)}</td>
                <td className={`${CELL} whitespace-nowrap text-amber-700`}>{formatDuration(row.otMinutes)}</td>
                <td className={CELL}>
                  <StatusChip
                    tone={row.status === "rejected" ? "danger" : row.status === "announced" ? "success" : "warning"}
                  >
                    {row.statusLabel}
                  </StatusChip>
                </td>
                <td className={`${CELL} text-gray-700`}>{row.status === "announced" ? assignedText(row) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager paged={paged} />
    </SectionCard>
  );
}
