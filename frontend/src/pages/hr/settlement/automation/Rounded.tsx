import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SettlementRounding } from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import { formatMoney } from "../shared";
import { roundingNote, roundingSteps } from "./rounding";

/**
 * The Salary Advance rounding in a table (owner 2026-11-27): the rounded amount with one short line when it matters, and
 * how it was worked out as the hover text - the shared Radix tooltip, drawn in a portal above the page, so the table's
 * scroll box never cuts it off and it never widens the table. The trigger is focusable, so the keyboard reaches the
 * explanation too.
 */
export function RoundingTip({
  rounding,
  children,
  testId,
  className,
}: {
  rounding: SettlementRounding;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const steps = roundingSteps(rounding);
  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={60}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300",
              className,
            )}
            data-steps={steps}
            data-testid={testId}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="max-w-xs rounded-lg border-0 bg-slate-900 px-3 py-2 text-[11.5px] leading-snug text-white shadow-xl"
          data-testid={testId ? `${testId}-tip` : undefined}
        >
          {steps}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The Rounded column: the rounded amount (semibold, tabular), and under it "capped at limit", "rounded up" or, in red,
 *  "rounds to ₹0 — reject". */
export function RoundedCell({ rounding, testId }: { rounding: SettlementRounding; testId?: string }) {
  const note = roundingNote(rounding);
  return (
    <RoundingTip rounding={rounding} testId={testId} className="inline-block whitespace-nowrap leading-tight">
      <span
        className={cn("block text-sm font-semibold tabular-nums", rounding.zero ? "text-red-600" : "text-slate-900")}
      >
        {formatMoney(rounding.rounded)}
      </span>
      {note && (
        <span
          className={cn(
            "mt-0.5 block text-[11px]",
            note.tone === "red" ? "font-medium text-red-600" : "text-muted-foreground",
          )}
          data-testid={testId ? `${testId}-note` : undefined}
        >
          {note.text}
        </span>
      )}
    </RoundingTip>
  );
}

/** The rounded amount as one muted line under the amount asked for ("rounded ₹11,500"; red "rounds to ₹0"), where the
 *  table has no room for the Rounded column; nothing when the rounding changed nothing. */
export function RoundedLine({
  rounding,
  testId,
  className,
}: {
  rounding: SettlementRounding;
  testId?: string;
  className?: string;
}) {
  return (
    <RoundingTip rounding={rounding} testId={testId} className={cn("mt-0.5 block text-[11px]", className)}>
      {rounding.zero ? (
        <span className="font-medium text-red-600">rounds to ₹0</span>
      ) : (
        <span className="text-muted-foreground">
          rounded <span className="tabular-nums">{formatMoney(rounding.rounded)}</span>
        </span>
      )}
    </RoundingTip>
  );
}
