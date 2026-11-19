import { useEffect, useId, useState } from "react";
import { Clock3, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useTeaBreakRule, useUpdateTeaBreakRule } from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "../kit";
import { gateKey } from "../routes";
import { NOT_RETURNED_MINUTES } from "./teaBreak";

/**
 * The Rule tab: how many minutes a tea break may take. One number for every branch. Saving refreshes every list and
 * figure on the page (useUpdateTeaBreakRule), because the server works out on time / overtime from the rule as it
 * stands. A role that may only view the tab sees the number and cannot change it.
 */
export function TeaBreakRuleCard() {
  const { toast } = useToast();
  const level = useLevel();
  const canEdit = level(gateKey("tea-break", "rule")) === "edit";
  const { data: rule, isLoading, isError } = useTeaBreakRule();
  const update = useUpdateTeaBreakRule();
  const [minutes, setMinutes] = useState("");
  const inputId = "tea-break-allowed-minutes";
  const hintId = useId();

  useEffect(() => {
    if (rule) setMinutes(String(rule.allowedMinutes));
  }, [rule?.allowedMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = Number(minutes);
  const valid = minutes.trim() !== "" && Number.isInteger(parsed) && parsed >= 1;

  const save = async () => {
    if (!valid) {
      toast({ title: "Enter a whole number of minutes, 1 or more", variant: "destructive" });
      return;
    }
    try {
      const saved = await update.mutateAsync(parsed);
      toast({
        title: "Tea break rule saved",
        description: `Breaks over ${saved.allowedMinutes} min now count as overtime, old ones included.`,
      });
    } catch (err) {
      toast({
        title: "Could not save the rule",
        description: err instanceof Error ? err.message : "Try again in a minute.",
        variant: "destructive",
      });
    }
  };

  return (
    <section
      className="max-w-3xl rounded-2xl border border-slate-200/80 bg-white"
      data-testid="tea-break-rule"
      aria-labelledby={`${hintId}-title`}
    >
      <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Clock3 size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id={`${hintId}-title`} className="text-base font-semibold text-slate-900">
            Allowed break time
          </h3>
          <p className="mt-0.5 text-sm text-slate-500">
            One rule for every branch. A break longer than this counts as overtime once the employee is back.
          </p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-rose-700" role="alert">
            Could not load the rule. Reload the page to try again.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Allowed minutes
            </label>
            <div className="flex items-center gap-2">
              <input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={minutes}
                disabled={!canEdit || isLoading}
                aria-describedby={hintId}
                aria-invalid={minutes !== "" && !valid}
                onChange={(e) => setMinutes(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canEdit && !update.isPending) {
                    e.preventDefault();
                    void save();
                  }
                }}
                className={cn(
                  "h-11 w-28 rounded-lg border bg-white px-3 text-base tabular-nums text-slate-900 outline-none sm:h-10",
                  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-slate-50",
                  minutes !== "" && !valid ? "border-rose-400" : "border-slate-200",
                )}
              />
              <span className="text-sm text-slate-500">min</span>
            </div>
          </div>
          {canEdit && (
            <Button
              type="button"
              className="h-11 gap-1.5 sm:h-10"
              disabled={update.isPending || isLoading}
              onClick={() => void save()}
            >
              <Save size={15} aria-hidden="true" /> {update.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
        <p id={hintId} className={cn("text-sm", minutes !== "" && !valid ? "text-rose-700" : "text-slate-500")}>
          {minutes !== "" && !valid
            ? "Enter a whole number of minutes, 1 or more."
            : rule?.updatedAt
              ? `Last changed ${fmtDateTime(rule.updatedAt, { year: true })}.`
              : "Not changed yet: 15 minutes is the starting rule."}
          {!canEdit && " Your role can see the rule but not change it."}
        </p>

        <ul className="space-y-1.5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <li>Back within the allowed minutes: on time. Longer: overtime, with the minutes over shown.</li>
          <li>
            Still out after {NOT_RETURNED_MINUTES} minutes: not returned. This hour is fixed and does not follow the
            rule.
          </li>
          <li>
            The rule is not stored with each break: changing it changes the overtime figures of earlier breaks too.
          </li>
          <li>Tea breaks are for tracking only. They do not change attendance or pay.</li>
        </ul>
      </div>
    </section>
  );
}
