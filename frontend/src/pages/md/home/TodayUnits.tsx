import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { clockText, pct } from "@/lib/md/format";
import { MD_CHART } from "@/lib/md/theme";
import { cn } from "@/lib/utils";
import { unitCaption } from "../dashboard/logic";
import { isSectionError, type DashboardOverview, type UnitRow } from "../dashboard/types";

/** The ring's colour by how today is going: sage from 90%, ochre from 75%, crimson below (null = not known yet). Wine is
 *  the brand and never means "bad": it is the colour of the whole-company ring, which is the headline, not a verdict. */
export const ringColor = (value: number | null): string =>
  value == null ? MD_CHART.neutral : value >= 90 ? MD_CHART.good : value >= 75 ? MD_CHART.watch : MD_CHART.bad;

/** A progress ring with the percentage inside, on a quiet track. Plain SVG. `color` overrides the threshold colour. */
export function Ring({
  value,
  size = 64,
  stroke = 7,
  color,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={value == null ? "No figure yet" : `${pct(value, 0)}`}
      className="shrink-0"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-md-ink/10" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color ?? ringColor(value)}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * filled} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700"
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className={cn("fill-md-ink font-black tabular-nums", size >= 80 ? "text-[18px]" : "text-[13px]")}
      >
        {value == null ? "—" : pct(value, 0)}
      </text>
    </svg>
  );
}

function UnitTile({ row }: { row: UnitRow }) {
  return (
    <li
      className="md-panel md-dashboard-row flex items-center gap-3.5 p-3.5"
      data-testid={`md-home-unit-${row.id ?? "none"}`}
    >
      <Ring value={row.attendancePct} size={60} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-md-ink">{row.name}</p>
        <p className="text-xs text-md-ink-soft">
          <b className="font-extrabold tabular-nums text-md-ink">{row.present}</b> of {row.expected} in
        </p>
        <p className="mt-0.5 truncate text-[11px] text-md-ink-soft">{unitCaption(row)}</p>
      </div>
    </li>
  );
}

/** What the ring colours mean, in words, so the colour is never the only thing saying it. */
function RingLegend() {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] font-medium text-md-ink-soft"
      aria-label="What the ring colours mean"
    >
      {[
        { dot: "bg-md-success-600", text: "90% and over" },
        { dot: "bg-md-warning-500", text: "75% to 89%" },
        { dot: "bg-md-danger-600", text: "Under 75%" },
      ].map((item) => (
        <li key={item.text} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("h-2 w-2 rounded-full", item.dot)} />
          {item.text}
        </li>
      ))}
    </ul>
  );
}

/** "Today at the factory": the whole company's attendance as one ring and every unit as a ring of its own, weakest first. */
export default function TodayUnits({
  overview,
  failed,
}: {
  overview: DashboardOverview | undefined;
  failed?: boolean;
}) {
  const units = overview?.units;
  const ready = units && !isSectionError(units) ? units : null;
  return (
    <SectionCard
      title="Today at the factory"
      subtitle={
        ready
          ? `${ready.isWorkingDay ? "Who is in" : "Not a working day"}${ready.asOf ? ` as of ${clockText(ready.asOf)}` : ""}${ready.provisional ? " · still arriving, so provisional" : ""}`
          : "Attendance by unit, weakest first"
      }
      loading={!overview && !failed}
      actions={
        <>
          <AskAiButton question="Which unit has the weakest attendance today, and why?" />
          <Link href="/md/branches" className="md-btn md-btn-soft md-btn-sm">
            Compare units <ArrowUpRight size={12} aria-hidden />
          </Link>
        </>
      }
      provenance={overview?.provenance}
      provenanceIds={["live-today"]}
      className="md-dashboard-card"
      testId="md-home-units"
    >
      {!ready ? (
        <p className="py-6 text-center text-sm text-md-ink-soft" data-testid="md-dashboard-unavailable">
          {units && isSectionError(units) ? units.error : "This could not be loaded, so nothing is shown here."}
        </p>
      ) : (
        <div className="space-y-5">
          <div className="md-panel-wine flex items-center gap-5 p-4 sm:p-5" data-testid="md-home-company-ring">
            <Ring value={ready.total.attendancePct} size={96} stroke={10} color={CHART.brand} />
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-md-wine">Whole company</p>
              <p className="mt-0.5 text-2xl font-black tabular-nums leading-tight text-md-ink">
                {ready.total.present}{" "}
                <span className="text-sm font-semibold text-md-ink-soft">of {ready.total.expected} in</span>
              </p>
              <p className="mt-0.5 text-xs text-md-ink-soft">{unitCaption(ready.total)}</p>
            </div>
          </div>
          {ready.rows.length === 0 ? (
            <p className="text-center text-xs text-md-ink-soft">No units to show.</p>
          ) : (
            <ul className={cn("grid gap-3", ready.rows.length > 2 ? "grid-cols-1 @xl:grid-cols-2" : "grid-cols-1")}>
              {ready.rows.map((row) => (
                <UnitTile key={row.id ?? row.name} row={row} />
              ))}
            </ul>
          )}
          <RingLegend />
        </div>
      )}
    </SectionCard>
  );
}
