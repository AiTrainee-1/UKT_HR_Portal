import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine } from "../kit/SettingBlock";
import { parseNumber, RANGES } from "../payroll/form";
import { formatPaise } from "../payroll/preview";
import type { LatePenalty } from "./preview";
import type { SlabErrors, SlabRow } from "../late_detection/production";

/** The made-up production worker every example on these tabs uses. */
export const PER_SHIFT = 600;

const GRID = [0, 2, 4, 6, 9, 12, 15, 20];

/** "-0.25 shift = ₹150.00" or "No deduction". */
export const cutText = (shifts: number, penalty: number): string =>
  shifts > 0 ? `-${shifts} shift${shifts > 1 ? "s" : ""} = ${formatPaise(penalty)}` : "No deduction";

/** A row to add after the existing ones: three lates past the highest threshold, a quarter shift. */
export function nextSlabRow(slabs: SlabRow[]): SlabRow {
  const highest = slabs.reduce((max, s) => {
    const from = parseNumber(s.fromLates, RANGES.lateCount).value;
    return from === null ? max : Math.max(max, from);
  }, 0);
  return { fromLates: String(highest + 3), deductionShifts: "0.25" };
}

/**
 * The slab table of one late pool (a pay cycle's): a row per threshold of billable lates and the shifts it costs, with
 * the cell errors next to the cells and the "a row starts at 0" warning. The same editor serves every cycle; `testId`
 * tells them apart in tests.
 */
export function SlabTable({
  slabs,
  errors,
  everyone,
  readOnly,
  onChange,
  testId,
}: {
  slabs: SlabRow[];
  errors: SlabErrors;
  /** A row starts at 0 billable lates with a deduction (deductsFromEveryone). */
  everyone: boolean;
  readOnly: boolean;
  onChange: (slabs: SlabRow[]) => void;
  testId: string;
}) {
  const setRow = (i: number, patch: Partial<SlabRow>) =>
    onChange(slabs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {slabs.length === 0 ? (
        <p
          className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-gray-500"
          data-testid={`${testId}-empty`}
        >
          No slabs: late days currently cost nothing. Add a slab to start deducting.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white">
          <table className="w-full text-sm" data-testid={testId}>
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-600">
                <th className="px-3 py-2 font-semibold">From this many billable lates</th>
                <th className="px-3 py-2 font-semibold">Deduct this many shifts</th>
                <th className="px-3 py-2 text-right font-semibold">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {slabs.map((slab, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 align-top">
                    <Input
                      inputMode="numeric"
                      aria-label={`Row ${i + 1}: from this many billable lates`}
                      aria-invalid={errors[i]?.fromLates ? true : undefined}
                      className={cn("h-8 max-w-[110px] tabular-nums", errors[i]?.fromLates && "border-red-400")}
                      value={slab.fromLates}
                      disabled={readOnly}
                      onChange={(e) => setRow(i, { fromLates: e.target.value })}
                    />
                    {errors[i]?.fromLates && (
                      <p className="mt-1 text-[11px] font-medium text-red-600">{errors[i]?.fromLates}</p>
                    )}
                  </td>
                  <td className="px-3 py-1.5 align-top">
                    <Input
                      inputMode="decimal"
                      aria-label={`Row ${i + 1}: deduct this many shifts`}
                      aria-invalid={errors[i]?.deductionShifts ? true : undefined}
                      className={cn("h-8 max-w-[110px] tabular-nums", errors[i]?.deductionShifts && "border-red-400")}
                      value={slab.deductionShifts}
                      disabled={readOnly}
                      onChange={(e) => setRow(i, { deductionShifts: e.target.value })}
                    />
                    {errors[i]?.deductionShifts && (
                      <p className="mt-1 text-[11px] font-medium text-red-600">{errors[i]?.deductionShifts}</p>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right align-top">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove slab ${i + 1}`}
                      title="Remove slab"
                      className="h-8 w-8 text-rose-600 hover:text-rose-800"
                      disabled={readOnly}
                      onClick={() => onChange(slabs.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => onChange([...slabs, nextSlabRow(slabs)])}
        disabled={readOnly}
      >
        <Plus size={13} /> Add Slab
      </Button>
      {everyone && (
        <p
          className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-800"
          data-testid={`${testId}-everyone-warning`}
        >
          A row starting at 0 billable lates deducts from every production worker in the period, those never late
          included. Start the first row at 1 or more unless that is meant.
        </p>
      )}
    </div>
  );
}

/** The worked example under a slab table: what 0 to 20 late days cost the example worker under the rows typed. */
export function SlabExample({
  price,
  invalid,
  everyone,
  testId,
}: {
  price: (lates: number) => LatePenalty;
  /** A cell is wrong: the grid would mislead, so it says to fix the values first. */
  invalid: boolean;
  everyone: boolean;
  testId: string;
}) {
  return (
    <PreviewCard
      title="Worked example"
      scenario={`With the allowance and rows above, ${formatPaise(PER_SHIFT * 100)} a shift.`}
      testId={testId}
    >
      {invalid ? (
        <p className="text-[12px] text-gray-500">Fix the values marked in red first to see the example.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {GRID.map((lates) => {
            const p = price(lates);
            return (
              <div key={lates} className="rounded-lg border border-blue-100 bg-white p-2">
                <p className="text-[11px] text-gray-500">
                  {lates} late day{lates === 1 ? "" : "s"}
                </p>
                <p className={cn("text-[12px] font-bold", p.shifts > 0 ? "text-amber-800" : "text-emerald-700")}>
                  {cutText(p.shifts, p.penalty)}
                </p>
                {p.billable > 0 && <p className="text-[10px] text-gray-400">{p.billable} billable</p>}
              </div>
            );
          })}
        </div>
      )}
      {everyone && (
        <PreviewLine
          tone="bad"
          label="A row starts at 0 billable lates"
          result="every worker is charged, even with no late day"
          testId={`${testId}-everyone`}
        />
      )}
    </PreviewCard>
  );
}
