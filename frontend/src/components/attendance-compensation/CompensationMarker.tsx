import { cn } from "@/lib/utils";
import {
  KIND_META,
  COMPENSATION_KINDS,
  compensationMark,
  kindLabel,
  type CompensationFields,
  type MarkKind,
} from "./kinds";

// How an attendance day shows that the employee used a compensation (see ./kinds.ts for the data). Three pieces, shared by
// every HR screen that draws a day, so the marker looks the same everywhere:
//   CompensationChip    the full chip (icon + words) for a list row or a detail view; the engine's note rides along as a
//                       tooltip and as text for a screen reader, or in plain sight with `withNote`
//   CompensationSymbol  a compact two-letter symbol for a month grid or a sheet cell; its label and note are an aria-label
//                       and a tooltip
//   CompensationLegend  what each symbol stands for, for the kinds in view
// Colour is never the only signal: every kind has its own icon, short code and words.

const CHIP_SIZE = { sm: "px-1.5 py-0.5 text-[10px]", md: "px-2 py-0.5 text-[11px]" } as const;
const ICON_SIZE = { sm: 10, md: 12 } as const;

/** The full chip of a day's compensation marker; nothing for an ordinary day. */
export function CompensationChip({
  day,
  size = "md",
  withNote = false,
  className,
}: {
  day: CompensationFields | null | undefined;
  size?: "sm" | "md";
  /** Show the engine's sentence under the chip instead of only in its tooltip (a detail view has the room). */
  withNote?: boolean;
  className?: string;
}) {
  const mark = compensationMark(day);
  if (!mark) return null;
  const meta = KIND_META[mark.kind];
  const Icon = meta.icon;
  const chip = (
    <span
      title={mark.title}
      data-testid={`compensation-chip-${mark.kind}`}
      data-kind={mark.kind}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border font-bold",
        CHIP_SIZE[size],
        meta.chip,
        !withNote && className,
      )}
    >
      <Icon size={ICON_SIZE[size]} aria-hidden="true" className="shrink-0" />
      {mark.label}
      {mark.note && !withNote && <span className="sr-only">. {mark.note}</span>}
    </span>
  );
  if (!withNote || !mark.note) return chip;
  return (
    <span className={cn("inline-flex max-w-full flex-col items-start gap-0.5", className)}>
      {chip}
      <span className="text-[11px] font-normal leading-snug text-gray-500" data-testid="compensation-note">
        {mark.note}
      </span>
    </span>
  );
}

/** A compact two-letter symbol (OT, LI, EO, BD, RX) for a grid cell; nothing for an ordinary day. */
export function CompensationSymbol({
  day,
  decorative = false,
  tooltip = true,
  className,
}: {
  day: CompensationFields | null | undefined;
  /** The words sit right beside it (the legend): hide the symbol from a screen reader instead of saying them twice. */
  decorative?: boolean;
  /** A native tooltip with the label and the note; off where the cell already has a tooltip of its own. */
  tooltip?: boolean;
  className?: string;
}) {
  const mark = compensationMark(day);
  if (!mark) return null;
  return (
    <span
      {...(decorative
        ? { "aria-hidden": true as const }
        : { role: "img" as const, "aria-label": mark.title, ...(tooltip ? { title: mark.title } : {}) })}
      data-testid={`compensation-symbol-${mark.kind}`}
      data-kind={mark.kind}
      className={cn(
        "inline-flex h-3.5 min-w-[1.1rem] select-none items-center justify-center rounded-[4px] px-0.5 text-[8px] font-black leading-none tracking-tight text-white ring-1 ring-white",
        KIND_META[mark.kind].solid,
        className,
      )}
    >
      {mark.short}
    </span>
  );
}

/**
 * What each compensation symbol stands for. `counts` (from countMarks) says which kinds are in view and adds how many days
 * of each ("x2"); `kinds` names them instead; with neither it lists all five. `describe` spells the meaning of every kind
 * out (a page-level legend), otherwise the meaning is a tooltip. Nothing renders when no kind is in view.
 */
export function CompensationLegend({
  kinds,
  counts,
  describe = false,
  className,
}: {
  kinds?: readonly MarkKind[];
  counts?: Partial<Record<MarkKind, number>>;
  describe?: boolean;
  className?: string;
}) {
  const shown: readonly MarkKind[] = kinds ?? (counts ? (Object.keys(counts) as MarkKind[]) : COMPENSATION_KINDS);
  if (shown.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Compensation markers"
      data-testid="compensation-legend"
      className={cn(
        describe
          ? "grid gap-x-6 gap-y-1.5 text-[11px] text-gray-600 sm:grid-cols-2"
          : "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-gray-600",
        className,
      )}
    >
      {!describe && <span className="font-semibold text-gray-500">Compensation used:</span>}
      {shown.map((kind) => {
        const meta = KIND_META[kind];
        const n = counts?.[kind];
        return (
          <span
            key={kind}
            className="inline-flex items-start gap-1.5"
            title={describe ? undefined : meta.meaning}
            data-testid={`compensation-legend-${kind}`}
          >
            <CompensationSymbol day={{ compensationKind: kind }} decorative className="mt-px shrink-0" />
            <span>
              <span className="font-semibold text-gray-700">{kindLabel(kind)}</span>
              {n != null && <span className="ml-1 tabular-nums text-gray-400">×{n}</span>}
              {describe && <span className="block text-gray-500">{meta.meaning}</span>}
            </span>
          </span>
        );
      })}
    </div>
  );
}
