import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The two kinds of slab table of the Staff page: late marks ("fromLates") and permissions ("fromPermissions"). */
export type SlabKey = "fromLates" | "fromPermissions";

export type SlabRowText<K extends SlabKey> = { [P in K]: string } & { deductionShifts: string };

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The slab table both staff pricing tables are made with: a row per threshold and the shifts it takes off, an "Add Slab"
 * button, a note when there are no rows, the problem with the rows (one line) and the warnings about rows that are allowed
 * but are almost certainly not meant. `keyName` is the row's threshold key and `labels` are the column headings, so the
 * Late Deduction Slabs ("From this many billable marks" / "Shifts taken off") and the Permission Deduction Slabs
 * ("From permissions" / "Deduct shifts") are one editor. `testId` tells the two tables apart in tests.
 */
export function SlabEditor<K extends SlabKey>({
  keyName,
  rows,
  onChange,
  disabled,
  labels,
  emptyText,
  min,
  max,
  nextStep,
  error,
  warnings = [],
  testId,
}: {
  keyName: K;
  rows: SlabRowText<K>[];
  onChange: (rows: SlabRowText<K>[]) => void;
  disabled?: boolean;
  /** The two column headings. */
  labels: { from: string; shifts: string };
  /** What the table says while it has no rows. */
  emptyText: string;
  /** The smallest and largest threshold the box accepts (the server's range). */
  min: number;
  max?: number;
  /** A new row starts this far past the highest threshold. */
  nextStep: number;
  error?: string | null;
  warnings?: string[];
  /** Prefix of the test ids: `${testId}-table`, `${testId}-empty`, `${testId}-error`, `${testId}-warning`. */
  testId: string;
}) {
  const setRow = (i: number, patch: Partial<SlabRowText<K>>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => {
    const highest = rows.reduce((top, r) => {
      const from = Number(r[keyName]);
      return Number.isFinite(from) && r[keyName].trim() !== "" ? Math.max(top, from) : top;
    }, 0);
    onChange([
      ...rows,
      { [keyName]: String(Math.max(min, highest + nextStep)), deductionShifts: "0.25" } as SlabRowText<K>,
    ]);
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500"
          data-testid={`${testId}-empty`}
        >
          {emptyText}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid={`${testId}-table`}>
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-600">
                <th className="px-3 py-2 font-semibold">{labels.from}</th>
                <th className="px-3 py-2 font-semibold">{labels.shifts}</th>
                <th className="px-3 py-2 text-right font-semibold">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5">
                    <Input
                      type="number"
                      min={min}
                      max={max}
                      step={1}
                      aria-label={`Row ${i + 1}: ${lowerFirst(labels.from)}`}
                      className="h-8 max-w-[110px]"
                      value={row[keyName]}
                      disabled={disabled}
                      onChange={(e) => setRow(i, { [keyName]: e.target.value } as Partial<SlabRowText<K>>)}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      type="number"
                      min={0}
                      step={0.25}
                      aria-label={`Row ${i + 1}: ${lowerFirst(labels.shifts)}`}
                      className="h-8 max-w-[110px]"
                      value={row.deductionShifts}
                      disabled={disabled}
                      onChange={(e) => setRow(i, { deductionShifts: e.target.value } as Partial<SlabRowText<K>>)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove slab ${i + 1}`}
                      title="Remove slab"
                      className="h-8 w-8 text-rose-600 hover:text-rose-800"
                      disabled={disabled}
                      onClick={() => onChange(rows.filter((_, j) => j !== i))}
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
      <Button size="sm" variant="outline" className="gap-1.5" onClick={addRow} disabled={disabled}>
        <Plus size={13} /> Add Slab
      </Button>
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
      {warnings.map((w) => (
        <p
          key={w}
          className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-800"
          data-testid={`${testId}-warning`}
        >
          {w}
        </p>
      ))}
    </div>
  );
}
