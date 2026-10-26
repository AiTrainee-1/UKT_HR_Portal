import { Link } from "wouter";
import { Landmark } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip } from "./parts";
import {
  CO_EMP_EMPLOYEES_PATH,
  PF_ESI_SETTINGS_PATH,
  STATUTORY_WHO_TEXT,
  summarizeRules,
  type PfEsiRulesSlice,
} from "./statutory-rules";

// The two small pieces the Generate dialogs and the Rules view share to say how PF, ESI and TDS apply to a payroll: a chip
// with how many PF / ESI rules there are for this kind of payroll (read from Settings -> PF & ESI), and the sentence on who
// they apply to. Nothing is invented: when the rules cannot be read the chip only says who PF / ESI apply to. The screen
// reads the rules once (`usePfEsiRulesSlice`) and hands them to both pieces.

/** What the pieces need of the rules query: the answer and whether it is still on its way. */
export type RulesRead = { data?: PfEsiRulesSlice; isLoading?: boolean };

/** "PF: 2 rules · ESI: 1 rule" (green), "No PF or ESI rules are set for Staff" (amber), or its skeleton while it loads. */
export function StatutoryRulesChip({ kind, rules, testId }: { kind: PayrollKind; rules: RulesRead; testId?: string }) {
  const summary = summarizeRules(kind, rules.data);
  if (rules.isLoading)
    return <Skeleton className="h-5 w-28 rounded-full" data-testid={testId && `${testId}-loading`} />;
  if (!summary) {
    return (
      <span data-testid={testId} data-state="unknown">
        <Chip tone="neutral" title="PF and ESI apply only to Co Emp employees, by the rules in Settings → PF & ESI">
          PF / ESI: Co Emp employees only
        </Chip>
      </span>
    );
  }
  return (
    <span data-testid={testId} data-state={summary.none ? "none" : "set"}>
      <Chip
        tone={summary.none ? "warning" : "success"}
        title={
          summary.none
            ? "Add rules in Settings → PF & ESI: until then nobody has PF or ESI deducted"
            : (summary.scope ?? "The PF and ESI rules in Settings → PF & ESI")
        }
      >
        {summary.text}
      </Chip>
    </span>
  );
}

/** Who PF, ESI and TDS apply to, with the two places that decide it (the rules, and the Co Emp / TDS lists). */
export function StatutoryWhoNote({
  kind,
  rules,
  linkClassName = "text-indigo-700",
  className,
  testId,
}: {
  kind: PayrollKind;
  rules: RulesRead;
  /** The text colour of the two links (indigo on Staff Payroll, amber on Production Payroll). */
  linkClassName?: string;
  className?: string;
  testId?: string;
}) {
  const summary = summarizeRules(kind, rules.data);
  return (
    <div className={cn("flex items-start gap-2 text-xs text-gray-600", className)} data-testid={testId}>
      <Landmark size={13} className="mt-0.5 shrink-0 text-slate-500" />
      <div className="space-y-1">
        <p>{STATUTORY_WHO_TEXT}</p>
        {summary?.none && (
          <p className="font-semibold text-amber-800" data-testid={testId && `${testId}-none`}>
            {summary.text}: nobody will have PF or ESI deducted until rules are added.
          </p>
        )}
        <p className="flex flex-wrap gap-x-3">
          <Link href={PF_ESI_SETTINGS_PATH} className={cn("font-semibold hover:underline", linkClassName)}>
            PF &amp; ESI rules
          </Link>
          <Link href={CO_EMP_EMPLOYEES_PATH} className={cn("font-semibold hover:underline", linkClassName)}>
            Co Emp and TDS employees
          </Link>
        </p>
      </div>
    </div>
  );
}
