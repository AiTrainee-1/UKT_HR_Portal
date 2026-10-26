import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PfEsiBasis, PfEsiBasisOption, PfEsiListKey } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Problem } from "../compensation/ui";
import {
  autoLabel,
  BASIS_SHORT,
  BASIS_VALUES,
  describeRow,
  LIST_TITLE,
  newRow,
  rangeWords,
  readAmount,
  readRate,
  type ListCheck,
  type RuleRow,
} from "./form";

/** The words each basis is explained with when the API does not send its own (it normally does: `basisOptions`). */
const FALLBACK_BASIS: PfEsiBasisOption[] = BASIS_VALUES.map((value) => ({
  value,
  label: BASIS_SHORT[value],
  description: "",
}));

/** "staff.pfRules" -> "staff-pf": the id the list's controls and tests carry. */
export const listSlug = (key: PfEsiListKey): string => key.replace(".pfRules", "-pf").replace(".esiRules", "-esi");

/**
 * One list of rules (Staff PF, Staff ESI, Production PF or Production ESI) as an editable table: a name, what the range is
 * measured on, From, To (0 = no upper limit) and the percentage, with add and delete (delete asks first). Every problem is
 * shown under the box it is about, as the server would say it.
 */
export function RuleList({
  listKey,
  rows,
  check,
  onChange,
  basisOptions,
  maxRules,
  locked,
}: {
  listKey: PfEsiListKey;
  rows: RuleRow[];
  check: ListCheck;
  onChange: (rows: RuleRow[]) => void;
  basisOptions: PfEsiBasisOption[];
  maxRules: number;
  /** Not the Super Admin (or a view-only role): the rules can be read, nothing can be changed. */
  locked: boolean;
}) {
  const title = LIST_TITLE[listKey];
  const slug = listSlug(listKey);
  const kindWord = listKey.endsWith("pfRules") ? "PF" : "ESI";
  const options = basisOptions.length > 0 ? basisOptions : FALLBACK_BASIS;
  const [deleting, setDeleting] = useState<number | null>(null);
  const full = rows.length >= maxRules;

  const change = (key: string, part: Partial<RuleRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...part } : r)));

  return (
    <div className="space-y-3" data-testid={`rules-${slug}`}>
      {rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500"
          data-testid={`rules-${slug}-empty`}
        >
          No {kindWord} rules: nobody pays {kindWord}. {locked ? "" : "Add a rule to start."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid={`rules-${slug}-table`}>
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-600">
                <th className="px-2 py-2 font-semibold">#</th>
                <th className="px-2 py-2 font-semibold">Rule name</th>
                <th className="px-2 py-2 font-semibold">Range based on</th>
                <th className="px-2 py-2 font-semibold">From (₹)</th>
                <th className="px-2 py-2 font-semibold">To (₹)</th>
                <th className="px-2 py-2 font-semibold">Percentage (%)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row, i) => {
                const e = check.rows[i] ?? {};
                const n = i + 1;
                const noLimit = !e.maxAmount && readAmount(row.maxAmount).value === 0;
                return (
                  <tr key={row.key} data-testid="rule-row" data-list={listKey} data-saved={row.id ? "true" : "false"}>
                    <td className="px-2 py-2 align-top">
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-xs font-semibold text-gray-500">{n}</span>
                        {!locked && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${title} rule ${n}`}
                            title="Delete this rule"
                            className="h-7 w-7 text-rose-600 hover:text-rose-800"
                            onClick={() => setDeleting(i)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 align-top">
                      <Input
                        type="text"
                        aria-label={`${title} rule ${n}: name`}
                        className={cn("h-8 min-w-[8rem]", e.label && "border-red-400")}
                        value={row.label}
                        disabled={locked}
                        placeholder={autoLabel(i)}
                        aria-invalid={e.label ? true : undefined}
                        onChange={(ev) => change(row.key, { label: ev.target.value })}
                      />
                      {e.label && <Problem>{e.label}</Problem>}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <select
                        aria-label={`${title} rule ${n}: range based on`}
                        className={cn(
                          "h-8 w-full min-w-[11rem] rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60",
                          e.basis && "border-red-400",
                        )}
                        value={row.basis}
                        disabled={locked}
                        onChange={(ev) => change(row.key, { basis: ev.target.value as PfEsiBasis })}
                      >
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {e.basis && <Problem>{e.basis}</Problem>}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <Input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`${title} rule ${n}: from amount`}
                        className={cn("h-8 w-28 tabular-nums", e.minAmount && "border-red-400")}
                        value={row.minAmount}
                        disabled={locked}
                        aria-invalid={e.minAmount ? true : undefined}
                        onChange={(ev) => change(row.key, { minAmount: ev.target.value })}
                      />
                      {e.minAmount && <Problem testId={`${slug}-${i}-from-error`}>{e.minAmount}</Problem>}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <Input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`${title} rule ${n}: to amount`}
                        className={cn("h-8 w-28 tabular-nums", e.maxAmount && "border-red-400")}
                        value={row.maxAmount}
                        disabled={locked}
                        aria-invalid={e.maxAmount ? true : undefined}
                        onChange={(ev) => change(row.key, { maxAmount: ev.target.value })}
                      />
                      {e.maxAmount ? (
                        <Problem testId={`${slug}-${i}-to-error`}>{e.maxAmount}</Problem>
                      ) : (
                        noLimit && (
                          <p className="text-xs font-semibold text-emerald-700" data-testid={`${slug}-${i}-no-limit`}>
                            No limit
                          </p>
                        )
                      )}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          aria-label={`${title} rule ${n}: percentage`}
                          className={cn("h-8 w-20 tabular-nums", e.ratePercent && "border-red-400")}
                          value={row.ratePercent}
                          disabled={locked}
                          aria-invalid={e.ratePercent ? true : undefined}
                          onChange={(ev) => change(row.key, { ratePercent: ev.target.value })}
                        />
                        <span className="text-xs font-semibold text-gray-500">%</span>
                      </div>
                      {e.ratePercent && <Problem testId={`${slug}-${i}-rate-error`}>{e.ratePercent}</Problem>}
                      {e.row && <Problem testId={`${slug}-${i}-row-error`}>{e.row}</Problem>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {check.list && <Problem testId={`rules-${slug}-error`}>{check.list}</Problem>}

      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={full}
            onClick={() => onChange([...rows, newRow(rows)])}
            data-testid={`rules-${slug}-add`}
          >
            <Plus size={13} /> Add a rule
          </Button>
          <span className="text-xs text-gray-500">
            {full
              ? `A list can have at most ${maxRules} rules.`
              : "The first rule whose range fits applies, so keep the ranges apart."}
          </span>
        </div>
      )}

      <div className="space-y-1.5" data-testid={`rules-${slug}-legend`}>
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Range based on</p>
        <ul className="space-y-0.5 text-xs leading-snug text-gray-600">
          {options.map((o) => (
            <li key={o.value}>
              <span className="font-semibold text-gray-800">{o.label}</span>
              {o.description ? ` - ${o.description}` : ""}
            </li>
          ))}
        </ul>
        <p className="text-xs leading-snug text-gray-500">
          To = 0 means there is no upper limit. Both ends of a range are included.
        </p>
      </div>

      <PlainWords listKey={listKey} rows={rows} kindWord={kindWord} />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent data-testid="confirm-delete-rule-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {title} rule {deleting === null ? "" : deleting + 1}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {deleting !== null && rows[deleting] && (
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-gray-700">
                    {describeRow(rows[deleting])}
                  </p>
                )}
                <p>
                  The rule leaves this list now, and the change is saved only when you press Save PF &amp; ESI Rules.
                  Employees who fitted only this rule will pay no {kindWord} from the next payroll generated. Payslips
                  already generated are never changed.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the rule</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-rule"
              onClick={() => {
                if (deleting !== null) onChange(rows.filter((_, i) => i !== deleting));
                setDeleting(null);
              }}
            >
              Delete rule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The list as sentences, for someone who would rather read than decode a table. */
function PlainWords({ listKey, rows, kindWord }: { listKey: PfEsiListKey; rows: RuleRow[]; kindWord: string }) {
  const sentences = rows.flatMap((row, i) => {
    const min = readAmount(row.minAmount).value;
    const max = readAmount(row.maxAmount).value;
    const rate = readRate(row.ratePercent).value;
    if (min === null || max === null || rate === null) return [];
    const name = row.label.trim() || autoLabel(i);
    return [`${name}: ${BASIS_SHORT[row.basis]} ${rangeWords(min, max)} pays ${rate}% ${kindWord}.`];
  });
  return (
    <div className="space-y-1" data-testid={`rules-${listSlug(listKey)}-words`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">In plain words</p>
      <ul className="space-y-0.5 text-xs leading-snug text-gray-700">
        {sentences.map((s) => (
          <li key={s} className="flex gap-1.5">
            <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-gray-400" />
            <span>{s}</span>
          </li>
        ))}
        <li className="flex gap-1.5 text-gray-500">
          <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-gray-300" />
          <span>Anyone who fits none of these pays no {kindWord}.</span>
        </li>
      </ul>
    </div>
  );
}
