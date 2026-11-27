import type { ReactNode } from "react";
import { Avatar } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

const PRESSED: Record<"blue" | "emerald" | "amber" | "red", string> = {
  blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-1 ring-red-200",
};
const INK: Record<"blue" | "emerald" | "amber" | "red", string> = {
  blue: "text-slate-600 hover:text-blue-700",
  emerald: "text-slate-600 hover:text-emerald-700",
  amber: "text-slate-600 hover:text-amber-700",
  red: "text-red-500 hover:text-red-600",
};

/** The hover label's colour: ActionTooltip's own (components/ui/action-tooltip.tsx), so it reads the same as on All
 *  Employees. */
const TIP: Record<"blue" | "emerald" | "amber" | "red", string> = {
  blue: "#2563eb",
  emerald: "#059669",
  amber: "#d97706",
  red: "#dc2626",
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
}: {
  label: string;
  icon: ReactNode;
  color: "blue" | "emerald" | "amber" | "red";
  onClick: () => void;
  testId: string;
  aria: string;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={60}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              size="icon"
              variant="ghost"
              className={cn("h-8 w-8 rounded-lg", pressed ? PRESSED[color] : INK[color])}
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              disabled={disabled}
              aria-pressed={pressed === undefined ? undefined : pressed}
              aria-label={aria}
              data-testid={testId}
            >
              {icon}
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
