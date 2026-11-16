import { useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, Loader2, UserPlus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dateShort, inr, plural } from "@/components/payroll/kit/format";
import { Chip, SectionCard } from "@/components/payroll/kit/parts";
import { useToast } from "@/hooks/use-toast";
import {
  useProductionNewJoiners,
  useProductionPeriodActions,
  type CyclePeriod,
  type NewJoinerRow,
  type PayCycle,
} from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { formatPeriod } from "./logic";
import { newJoinerDays, newJoinerReason } from "./period-workflow";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "") : undefined);

function JoinerRow({
  row,
  canAdd,
  adding,
  onAdd,
  onOpenDetails,
}: {
  row: NewJoinerRow;
  canAdd: boolean;
  adding: boolean;
  onAdd?: (row: NewJoinerRow) => void;
  onOpenDetails: (payrollId: number) => void;
}) {
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`pcp-nj-row-${row.employeeCode}`}
      data-parked={row.parked ? "true" : "false"}
    >
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-gray-900">
          <span className="break-words">{row.employeeName}</span>
          <span className="font-mono text-xs font-normal text-muted-foreground">{row.employeeCode}</span>
          {row.departmentName && <span className="text-xs font-normal text-gray-500">· {row.departmentName}</span>}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          <Chip tone={row.move ? "accent" : "info"}>{row.move ? "Moved in" : "New joiner"}</Chip>
          <span className="text-gray-700" data-testid={`pcp-nj-reason-${row.employeeCode}`}>
            {newJoinerReason(row)}
          </span>
        </p>
        <p className="text-xs text-gray-600" data-testid={`pcp-nj-days-${row.employeeCode}`}>
          {newJoinerDays(row.days)}
        </p>
        {!row.parked && row.addedToPayrollAt && (
          <p className="text-[11px] text-emerald-700">
            Added to the payroll {dateShort(row.addedToPayrollAt.slice(0, 10))}
            {row.addedToPayrollBy ? ` by ${row.addedToPayrollBy}` : ""}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <span className="text-sm font-black tabular-nums text-green-700" title="Net pay of this period">
          {inr(row.finalSalary)}
        </span>
        <button
          type="button"
          onClick={() => onOpenDetails(row.id)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 hover:underline"
          data-testid={`pcp-nj-details-${row.employeeCode}`}
        >
          Details <ArrowRight size={12} />
        </button>
        {row.parked && onAdd && (
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
            disabled={!canAdd || adding}
            onClick={() => onAdd(row)}
            data-testid={`pcp-nj-add-${row.employeeCode}`}
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />} Add to payroll
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * New Joiners of one pay period (owner 2026-11-16): workers who joined during the period AND workers who moved here from
 * another pay cycle (their first period here), together. They are calculated as usual but kept out of the records, the
 * totals, the bank file and the Salary Statement until HR adds them (one by one or all); once added they stay added when
 * the period is generated again. Payroll Done waits until nobody is left here, so nobody's wages are dropped. Nothing is
 * shown while the period has nobody new.
 */
export function NewJoinersSection({
  cycle,
  period,
  onOpenDetails,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  onOpenDetails: (payrollId: number) => void;
}) {
  const { toast } = useToast();
  const level = useLevel();
  const visible = level("production_payroll.new_joiners") !== "hidden";
  const query = useProductionNewJoiners(cycle, period, visible);
  const { addToPayroll } = useProductionPeriodActions();
  const [addingId, setAddingId] = useState<number | "all" | null>(null);
  const [showAdded, setShowAdded] = useState(false);
  const data = query.data;
  if (!visible || !data || (data.waiting.length === 0 && data.added.length === 0)) return null;

  const mayAdd = data.canAdd && level("production_payroll.new_joiners") === "edit";
  const periodLabel = formatPeriod(period);

  const add = async (rows: NewJoinerRow[], all: boolean) => {
    setAddingId(all ? "all" : rows[0].id);
    try {
      const result = await addToPayroll.mutateAsync(
        all ? { cycle, period, all: true } : { payrollIds: rows.map((r) => r.id) },
      );
      toast({
        title:
          result.added === 1 && rows.length === 1
            ? `${rows[0].employeeName ?? "The worker"} added to the payroll`
            : `${plural(result.added, "worker")} added to the payroll`,
        description: "Now in the records, the totals, the bank file and the Salary Statement.",
      });
    } catch (err) {
      toast({ title: "Could not add to the payroll", description: errorText(err), variant: "destructive" });
    } finally {
      setAddingId(null);
    }
  };

  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          New Joiners
          {data.waiting.length > 0 && (
            <Chip tone="warning">
              <span data-testid="pcp-nj-waiting-count">{data.waiting.length}</span> waiting
            </Chip>
          )}
        </span>
      }
      description={
        data.waiting.length > 0
          ? `Joined during ${periodLabel} or moved here from another pay cycle. Calculated as usual, but kept out of the records, totals, bank file and Salary Statement until you add them (${inr(data.waitingNet)} waiting). Payroll Done waits until nobody is left here.`
          : `Everyone who joined during ${periodLabel} or moved here from another pay cycle has been added to the payroll.`
      }
      icon={UsersRound}
      testId="pcp-new-joiners"
      bodyClassName="space-y-3"
      actions={
        data.waiting.length > 1 && mayAdd ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 border-amber-300 text-amber-800 hover:bg-amber-50"
            disabled={addingId !== null}
            onClick={() => void add(data.waiting, true)}
            data-testid="pcp-nj-add-all"
          >
            {addingId === "all" ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />} Add all{" "}
            {data.waiting.length}
          </Button>
        ) : undefined
      }
    >
      {data.waiting.length > 0 && (
        <ul className="space-y-2" data-testid="pcp-nj-waiting">
          {data.waiting.map((row) => (
            <JoinerRow
              key={row.id}
              row={row}
              canAdd={mayAdd && addingId === null}
              adding={addingId === row.id}
              onAdd={(r) => void add([r], false)}
              onOpenDetails={onOpenDetails}
            />
          ))}
        </ul>
      )}
      {data.waiting.length > 0 && !mayAdd && (
        <p className="text-xs text-muted-foreground" data-testid="pcp-nj-cannot-add">
          {data.locked
            ? "This period is finalized: nobody can be added any more."
            : "Your role can see New Joiners but cannot add them to the payroll."}
        </p>
      )}
      {data.added.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAdded((v) => !v)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600 hover:text-gray-900"
            aria-expanded={showAdded}
            data-testid="pcp-nj-added-toggle"
          >
            {showAdded ? <ChevronUp size={13} /> : <ChevronDown size={13} />} Already added ({data.added.length})
          </button>
          {showAdded && (
            <ul className="mt-2 space-y-2" data-testid="pcp-nj-added">
              {data.added.map((row) => (
                <JoinerRow key={row.id} row={row} canAdd={false} adding={false} onOpenDetails={onOpenDetails} />
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}
