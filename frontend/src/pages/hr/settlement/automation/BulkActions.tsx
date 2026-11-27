import type { ReactNode } from "react";
import { CheckCheck, CheckCircle2, UserCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What can be done to several requests at once on the Requests tab: approve / reject (HR Review, HR Final Settlement),
 *  or, in a rework stage (2026-11-27), accept the reviewer's change / keep HR's own (resolve-bulk). */
export type BulkKind = "approve" | "reject" | "accept" | "keep";

export type BulkButton = { kind: BulkKind; label: string };

const ICON: Record<BulkKind, ReactNode> = {
  approve: <CheckCircle2 size={14} aria-hidden />,
  reject: <XCircle size={14} aria-hidden />,
  accept: <CheckCheck size={14} aria-hidden />,
  keep: <UserCheck size={14} aria-hidden />,
};

/** Each button's colour, with the same feedback as the row actions (owner 2026-11-27: proper hover effects and visual
 *  feedback): a deeper tint and a one-pixel lift with a soft shadow on hover, sinking back when pressed, a focus ring. */
const SKIN: Record<BulkKind, string> = {
  approve: "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-300",
  accept: "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-300",
  keep: "bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-300",
  reject: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-100 focus-visible:ring-red-300",
};
const MOTION =
  "shadow-sm transition-[background-color,box-shadow,transform] duration-150 ease-out hover:-translate-y-px " +
  "hover:shadow-md active:translate-y-0 active:scale-[0.98] active:shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-2 motion-reduce:transform-none motion-reduce:transition-none disabled:shadow-none";

/** The bar above the Requests table: how many are ticked, Select all / Clear, and the stage's bulk buttons. Select all
 *  takes the requests the filter shows. */
export default function AutomationBulkBar({
  ticked,
  total,
  onSelectAll,
  onClear,
  buttons,
  onRun,
  note,
  busy,
  testId = "auto-bulk",
}: {
  ticked: number;
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  buttons: BulkButton[];
  onRun: (kind: BulkKind) => void;
  /** A line on what the bulk step does here. */
  note?: ReactNode;
  busy?: boolean;
  testId?: string;
}) {
  if (total === 0) return null;
  const any = ticked > 0;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2 transition-colors",
        any ? "border-sky-100 bg-sky-50/80" : "border-slate-100 bg-slate-50/40",
      )}
      role="region"
      aria-label="Several requests at once"
      data-view-safe
      data-testid={testId}
    >
      <span className="flex min-w-0 items-center gap-1 text-sm">
        <span
          className={cn("font-semibold", any ? "text-[#006496]" : "text-slate-600")}
          data-testid={`${testId}-count`}
        >
          {any ? `${ticked} of ${total} selected` : `${total} can be selected`}
        </span>
        {ticked < total && (
          <Button
            variant="link"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={onSelectAll}
            disabled={busy}
            data-testid={`${testId}-all`}
          >
            Select all ({total})
          </Button>
        )}
        {any && (
          <Button
            variant="link"
            size="sm"
            className="h-8 px-2 text-xs text-slate-500"
            onClick={onClear}
            disabled={busy}
            data-testid={`${testId}-clear`}
          >
            Clear
          </Button>
        )}
      </span>
      {note && <span className="hidden text-xs text-muted-foreground 2xl:inline">{note}</span>}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {buttons.map((b) => (
          <button
            key={b.kind}
            type="button"
            className={cn(
              "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-xs font-semibold",
              "disabled:pointer-events-none disabled:opacity-50",
              SKIN[b.kind],
              MOTION,
            )}
            onClick={() => onRun(b.kind)}
            disabled={busy || ticked === 0}
            data-testid={`${testId}-${b.kind}`}
          >
            {ICON[b.kind]} {b.label}
          </button>
        ))}
      </span>
    </div>
  );
}
