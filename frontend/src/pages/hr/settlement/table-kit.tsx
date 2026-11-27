import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Avatar } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReviewState } from "@/lib/reviewOrder";
import { TONE, type Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";

/**
 * The Loan & Advance tables' parts, in the HRMS house style (owner 2026-11-27: "use the All Employees table as the
 * reference"): the shared Table with its own quiet headers, an initials avatar with the name over one muted line (as the
 * Attendance day list), status pills from lib/statusTones, money right-aligned in tabular figures, and the row actions as
 * ghost icon buttons with a coloured hover label, as on All Employees.
 */

/** A column that only shows from a width on (the rest of the row stays readable on a laptop without a sideways scroll). */
export const FROM = {
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
  "2xl": "hidden 2xl:table-cell",
  /** 1680 px and up */
  "3xl": "hidden min-[1680px]:table-cell",
  /** 1800 px and up */
  wide: "hidden min-[1800px]:table-cell",
  /** a full-HD screen (1880 px and up) */
  full: "hidden min-[1880px]:table-cell",
} as const;

/** The first and last cell of a row get the card's own inset (as All Employees: pl-4 / pr-4). */
export const FIRST = "pl-4";
export const LAST = "pr-4";

/** A heading: the shared look (sentence case, muted, medium), kept on one line unless it is two short words. */
export const HEAD = "whitespace-nowrap";

export const muted = <span className="text-muted-foreground/60">—</span>;

/** The employee: initials, the name, then the code and the department on one muted line. */
export function PersonCell({
  name,
  code,
  department,
  badge,
  size = 32,
}: {
  name: string;
  code: string;
  department?: string | null;
  /** A small pill after the name ("Has left"). */
  badge?: ReactNode;
  size?: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar name={name} size={size} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-900">
          <span className="truncate">{name}</span>
          {badge}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{code}</span>
          {department ? <span> · {department}</span> : null}
        </p>
      </div>
    </div>
  );
}

/** A status pill with its dot (as the Attendance day list's status). */
export function Pill({
  tone = "neutral",
  children,
  className,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-tone={tone}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
        className,
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden />
      {children}
    </span>
  );
}

/** A figure with an optional muted line under it, right-aligned (a money column). */
export function Figure({
  value,
  sub,
  strong,
  tone,
}: {
  value: ReactNode;
  sub?: ReactNode;
  strong?: boolean;
  /** amber: over a limit / less than asked; red: rejected. */
  tone?: "amber" | "red" | "muted";
}) {
  return (
    <div className="whitespace-nowrap leading-tight">
      <p
        className={cn(
          "text-sm tabular-nums",
          strong ? "font-semibold text-slate-900" : "text-slate-700",
          tone === "amber" && "text-amber-700",
          tone === "red" && "font-semibold text-red-600",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** A row action's colour: blue (view / remark), emerald (approve), amber (reduce), red (reject / delete), violet
 *  (Rework: reopen a decision, 2026-11-27). */
export type ActionColor = "blue" | "emerald" | "amber" | "red" | "violet";

const PRESSED: Record<ActionColor, string> = {
  blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-1 ring-red-200",
  violet: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
};
/** At rest the icon is quiet; on hover it takes its colour on a soft tint of it, lifts a pixel and casts a small shadow;
 *  pressed it sinks back (owner 2026-11-27: "proper hover effects and visual feedback"). */
const INK: Record<ActionColor, string> = {
  blue: "text-slate-600 hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-blue-300",
  emerald: "text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:ring-emerald-300",
  amber: "text-slate-600 hover:bg-amber-50 hover:text-amber-700 focus-visible:ring-amber-300",
  red: "text-red-500 hover:bg-red-50 hover:text-red-600 focus-visible:ring-red-300",
  violet: "text-slate-600 hover:bg-violet-50 hover:text-violet-700 focus-visible:ring-violet-300",
};
const MOTION =
  "transition-[background-color,color,box-shadow,transform] duration-150 ease-out hover:-translate-y-px hover:shadow-sm " +
  "active:translate-y-0 active:scale-95 active:shadow-none focus-visible:outline-none focus-visible:ring-2 " +
  "motion-reduce:transform-none motion-reduce:transition-none disabled:hover:translate-y-0 disabled:hover:shadow-none";

/** The hover label's colour: ActionTooltip's own (components/ui/action-tooltip.tsx), so it reads the same as on All
 *  Employees. */
const TIP: Record<ActionColor, string> = {
  blue: "#2563eb",
  emerald: "#059669",
  amber: "#d97706",
  red: "#dc2626",
  violet: "#7c3aed",
};

/** A row action: a ghost icon button with its hover label (All Employees' Eye / Pencil / Trash). `pressed` marks the
 *  choice already made (HR's proposal) with the action's own tint.
 *
 *  The label is the shared Radix tooltip, drawn in a portal above the page (owner 2026-11-27: the in-place label was cut
 *  off by the table's own scroll box at the last column and pushed a sideways scrollbar): it keeps clear of the screen's
 *  edges and never changes the table's width. The trigger is a span around the button, so a disabled button ("Kept as
 *  asked") still shows why. */
export function RowAction({
  label,
  icon,
  color,
  onClick,
  testId,
  aria,
  disabled,
  pressed,
  busy,
}: {
  label: string;
  icon: ReactNode;
  color: ActionColor;
  onClick: () => void;
  testId: string;
  aria: string;
  disabled?: boolean;
  pressed?: boolean;
  /** Saving: a spinner in place of the icon, not clickable. */
  busy?: boolean;
}) {
  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={60}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              size="icon"
              variant="ghost"
              className={cn("h-8 w-8 rounded-lg", MOTION, INK[color], pressed && PRESSED[color])}
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              disabled={disabled || busy}
              aria-pressed={pressed === undefined ? undefined : pressed}
              aria-busy={busy || undefined}
              aria-label={aria}
              data-testid={testId}
            >
              {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="rounded-md border-0 px-2.5 py-1 text-[11px] font-bold text-white shadow-lg"
          style={{ backgroundColor: TIP[color] }}
          data-testid={`${testId}-tip`}
        >
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const GROUP_DOT: Record<ReviewState, string> = {
  pending: "bg-amber-500",
  approved: "bg-emerald-500",
  rejected: "bg-red-500",
};

/** A quiet divider row between a review list's groups (owner 2026-11-27: waiting requests at the top, approved below,
 *  rejected below those): a coloured dot, the group's name and how many. */
export function GroupRow({
  state,
  label,
  count,
  colSpan,
  testId,
}: {
  state: ReviewState;
  label: string;
  count: number;
  colSpan: number;
  testId?: string;
}) {
  return (
    <TableRow className="border-b-0 hover:bg-transparent" data-group={state} data-testid={testId}>
      <TableCell colSpan={colSpan} className="bg-slate-50/80 py-1.5 pl-4 pr-4">
        <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold text-slate-600">
          <span className={cn("h-1.5 w-1.5 rounded-full", GROUP_DOT[state])} aria-hidden />
          {label}
          <span className="rounded-full bg-white px-1.5 py-px text-[10.5px] font-bold tabular-nums text-slate-500 ring-1 ring-slate-200">
            {count}
          </span>
        </span>
      </TableCell>
    </TableRow>
  );
}

/** A row that just changed group (approved, rejected, reopened) glows for a moment where it landed, so the eye follows
 *  it: `flash(id)` after the save; `FLASH` on the row whose id is `flashId`. */
export const FLASH = "animate-in fade-in-0 slide-in-from-top-1 duration-500 bg-sky-50/80 motion-reduce:animate-none";

export function useFlash(ms = 1600): [number | null, (id: number) => void] {
  const [id, setId] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(
    (next: number) => {
      if (timer.current) clearTimeout(timer.current);
      setId(next);
      timer.current = setTimeout(() => setId(null), ms);
    },
    [ms],
  );
  return [id, flash];
}

/** The actions of a row, on one line at the right. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** A label / value pair of a phone card (sentence case, as the rest of the HRMS). */
export function CardField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{children}</dd>
    </div>
  );
}
