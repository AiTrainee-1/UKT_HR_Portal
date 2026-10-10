import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { clockText, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { unitCaption } from "../dashboard/logic";
import { isSectionError, type DashboardOverview, type UnitRow } from "../dashboard/types";

/** The ring's colour by how today is going: green from 90%, amber from 75%, red below (null = not known yet). */
export const ringColor = (value: number | null): string =>
  value == null ? "#94a3b8" : value >= 90 ? "#16a34a" : value >= 75 ? "#d97706" : "#dc2626";

/** A progress ring with the percentage inside. Plain SVG. */
export function Ring({ value, size = 64, stroke = 7 }: { value: number | null; size?: number; stroke?: number }) {
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
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={ringColor(value)}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * filled} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-[#1a3a4a] text-[13px] font-black"
      >
        {value == null ? "—" : pct(value, 0)}
      </text>
    </svg>
  );
}

function UnitTile({ row }: { row: UnitRow }) {
  return (
    <li
      className="flex items-center gap-3 rounded-2xl bg-white/80 p-3 ring-1 ring-[#006496]/10"
      data-testid={`md-home-unit-${row.id ?? "none"}`}
    >
      <Ring value={row.attendancePct} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-[#1a3a4a]">{row.name}</p>
        <p className="text-xs text-muted-foreground">
          <b className="text-[#1a3a4a]">{row.present}</b> of {row.expected} in
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{unitCaption(row)}</p>
      </div>
    </li>
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
          <Link
            href="/md/branches"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#006496] hover:underline"
          >
            Compare units <ArrowUpRight size={11} />
          </Link>
        </>
      }
      provenance={overview?.provenance}
      provenanceIds={["live-today"]}
      testId="md-home-units"
    >
      {!ready ? (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="md-dashboard-unavailable">
          {units && isSectionError(units) ? units.error : "This could not be loaded, so nothing is shown here."}
        </p>
      ) : (
        <div className="space-y-4">
          <div
            className="flex items-center gap-4 rounded-2xl bg-[#006496]/[0.05] p-3"
            data-testid="md-home-company-ring"
          >
            <Ring value={ready.total.attendancePct} size={84} stroke={9} />
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#006496]/70">Whole company</p>
              <p className="text-lg font-black text-[#1a3a4a]">
                {ready.total.present}{" "}
                <span className="text-sm font-semibold text-muted-foreground">of {ready.total.expected} in</span>
              </p>
              <p className="text-xs text-muted-foreground">{unitCaption(ready.total)}</p>
            </div>
          </div>
          {ready.rows.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground">No units to show.</p>
          ) : (
            <ul className={cn("grid gap-2.5", ready.rows.length > 2 ? "grid-cols-1 @xl:grid-cols-2" : "grid-cols-1")}>
              {ready.rows.map((row) => (
                <UnitTile key={row.id ?? row.name} row={row} />
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}
