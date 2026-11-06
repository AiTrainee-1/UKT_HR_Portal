// Journey History -> "Journey simulation": pick an employee and a day, pick one of that day's journeys, and replay it on the map.
// The journeys come from the same list the page shows (GET /api/tracking/journeys, filtered to the employee and the day).
import { useMemo, useState } from "react";
import { CalendarDays, Clapperboard, Play, Route as RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trackingErrorMessage, useJourneys } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { todayIst } from "../dutyMap";
import { EmployeePicker, type JourneyFilters } from "../JourneyList";
import { fmtDistance, fmtDuration, fmtTime } from "../logic";
import { LiveBadge } from "../ui";

export default function SimulationPicker({ onSimulate }: { onSimulate: (journeyId: number) => void }) {
  const [employee, setEmployee] = useState<JourneyFilters["employee"]>(null);
  const [date, setDate] = useState(todayIst());
  const [picked, setPicked] = useState<number | null>(null);
  const today = todayIst();
  const query = useJourneys(
    { employeeId: employee?.id ?? null, from: date, to: date, page: 1, pageSize: 50 },
    employee !== null && date !== "",
  );
  const journeys = useMemo(() => (employee ? (query.data?.results ?? []) : []), [employee, query.data]);
  // one journey that day: it is the one
  const chosen =
    picked !== null && journeys.some((j) => j.id === picked) ? picked : journeys.length === 1 ? journeys[0].id : null;

  return (
    <section className="clay-card rounded-2xl border border-slate-100 p-4 sm:p-5" data-testid="sim-picker">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 rounded-xl bg-sky-50 p-2 text-sky-700 ring-1 ring-sky-100">
            <Clapperboard size={16} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-gray-900">Journey simulation</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Replay a recorded journey on the map: pick the employee and the day, then the journey.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor="sim-employee" className="mb-1 block text-xs font-semibold text-gray-600">
            Employee
          </label>
          <EmployeePicker
            value={employee}
            onChange={(next) => {
              setEmployee(next);
              setPicked(null);
            }}
            inputId="sim-employee"
            testIdPrefix="sim-employee"
          />
        </div>
        <div>
          <label htmlFor="sim-date" className="mb-1 block text-xs font-semibold text-gray-600">
            Day
          </label>
          <div className="relative">
            <CalendarDays
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              aria-hidden
            />
            <Input
              id="sim-date"
              type="date"
              className="h-9 pl-9 text-sm"
              value={date}
              max={today}
              onChange={(e) => {
                setDate(e.target.value);
                setPicked(null);
              }}
              data-testid="sim-date"
            />
          </div>
        </div>
        <Button
          type="button"
          className="h-9 gap-1.5"
          disabled={chosen === null}
          onClick={() => chosen !== null && onSimulate(chosen)}
          data-testid="sim-start"
        >
          <Play size={14} /> Simulate journey
        </Button>
      </div>

      {employee && (
        <div className="mt-3" data-testid="sim-journeys">
          {query.isPending ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Skeleton className="h-14 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
            </div>
          ) : query.isError ? (
            <p role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
              The journeys could not be loaded ({trackingErrorMessage(query.error, "connection problem")}).{" "}
              <button type="button" className="font-semibold underline" onClick={() => void query.refetch()}>
                Try again
              </button>
            </p>
          ) : journeys.length === 0 ? (
            <p
              className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-gray-500"
              data-testid="sim-none"
            >
              No journey was recorded for {employee.label} on that day. A journey starts when the employee submits an
              On-Duty request; pick another day.
            </p>
          ) : (
            <div
              className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
              role="radiogroup"
              aria-label="Journeys of the day"
            >
              {journeys.map((j) => {
                const on = j.id === chosen;
                return (
                  <button
                    key={j.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPicked(j.id)}
                    onDoubleClick={() => onSimulate(j.id)}
                    data-testid="sim-journey-option"
                    className={cn(
                      "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      on
                        ? "border-sky-300 bg-sky-50 ring-1 ring-sky-200"
                        : "border-slate-200 bg-white hover:bg-slate-50",
                    )}
                  >
                    <RouteIcon size={15} className={cn("mt-0.5 shrink-0", on ? "text-sky-700" : "text-slate-400")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-gray-900">
                        {j.destination || "No destination"}
                      </span>
                      <span className="block text-[11px] tabular-nums text-gray-600">
                        {fmtTime(j.startedAt)} - {j.status === "active" ? "now" : fmtTime(j.endedAt)} ·{" "}
                        {fmtDuration(j.durationS)} · {fmtDistance(j.distanceM)}
                      </span>
                    </span>
                    {j.status === "active" && <LiveBadge />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
