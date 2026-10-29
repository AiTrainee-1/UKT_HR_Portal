// Journey History: the list. One row per track (one On-Duty request, from the moment it was submitted): who, where to, when it
// started and ended and why, how long, how far, the stops and gaps, the events, the approval and whether a fake GPS showed up.
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Coffee,
  MapPinned,
  Radio,
  RotateCcw,
  Route as RouteIcon,
  Search,
  Timer,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, SectionCard } from "@/components/payroll/kit/parts";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useListEmployees } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  isTrackingForbidden,
  trackingErrorMessage,
  useJourneys,
  type JourneyListItem,
} from "@/lib/api-client/custom-hooks";
import {
  END_REASONS,
  END_REASON_LABEL,
  endReasonLabel,
  fmtDateTime,
  fmtDistance,
  fmtDuration,
  sameReason,
  timeAgo,
} from "./logic";
import { ApprovalChip, Chip, EmptyNote, LiveBadge, StatePill } from "./ui";

export type JourneyFilters = {
  employee: { id: number; label: string } | null;
  from: string;
  to: string;
  status: "" | "active" | "ended";
  endReason: string;
  page: number;
  pageSize: number;
};

export const DEFAULT_FILTERS: JourneyFilters = {
  employee: null,
  from: "",
  to: "",
  status: "",
  endReason: "",
  page: 1,
  pageSize: 25,
};

export const filtersAreSet = (f: JourneyFilters): boolean =>
  f.employee !== null || f.from !== "" || f.to !== "" || f.status !== "" || f.endReason !== "";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";

/** A search box over the active employees: pick one and the list shows only that person's journeys. */
function EmployeePicker({
  value,
  onChange,
}: {
  value: JourneyFilters["employee"];
  onChange: (next: JourneyFilters["employee"]) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const { data: employees } = useListEmployees({ status: "active" });

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return (employees ?? [])
      .filter(
        (e) => e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [employees, text]);

  if (value) {
    return (
      <div
        className="flex h-9 items-center justify-between gap-2 rounded-md border bg-gray-50 px-3 text-sm"
        data-testid="employee-filter-chosen"
      >
        <span className="truncate font-semibold">{value.label}</span>
        <button
          type="button"
          aria-label="Clear the employee filter"
          className="shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-200"
          onClick={() => {
            onChange(null);
            setText("");
          }}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder="Search employee by name or code"
        id="journey-employee"
        aria-label="Search employee"
        className="h-9 pl-9 text-sm"
        data-testid="employee-filter-input"
      />
      {open && text.trim() !== "" && (
        <ul
          role="listbox"
          aria-label="Matching employees"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-white py-1 text-sm"
          data-testid="employee-filter-options"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-gray-500">No employee matches "{text.trim()}".</li>
          ) : (
            matches.map((e) => (
              <li key={e.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-gray-100"
                  // mouse-down, not click: the box loses focus (and closes) before a click lands
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    onChange({ id: e.id, label: `${e.firstName} ${e.lastName} (${e.employeeCode})` });
                    setText("");
                    setOpen(false);
                  }}
                >
                  <span className="font-semibold">
                    {e.firstName} {e.lastName}
                  </span>{" "}
                  <span className="font-mono text-xs text-gray-500">{e.employeeCode}</span>
                  <span className="block text-xs text-gray-500">{e.departmentName ?? "No department"}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** The journeys that are still being recorded, as cards above the list: who is out right now and what they are doing. */
function LiveNow({ items, onOpen }: { items: JourneyListItem[]; onOpen: (id: number) => void }) {
  return (
    <section data-testid="live-now" aria-label="On duty now">
      <h3 className="mb-2 flex items-center gap-2 px-1 text-xs font-bold uppercase tracking-wide text-slate-500">
        <Radio size={13} className="text-emerald-600" /> On duty now
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
          {items.length}
        </span>
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid="live-now-card"
            onClick={() => onOpen(item.id)}
            className="clay-card flex items-center gap-3 rounded-2xl border border-slate-100 p-3.5 text-left transition-shadow hover:shadow-md"
          >
            <Avatar name={item.employeeName} size={42} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-bold text-gray-900">{item.employeeName}</span>
                <StatePill state={item.state} testId="live-now-state" />
              </span>
              <span className="block truncate text-xs text-gray-600">{item.destination || "No destination"}</span>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                Out for {fmtDuration(item.durationS)} · {fmtDistance(item.distanceM)}
                {item.lastPointAt ? ` · last seen ${timeAgo(item.lastPointAt)}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** The grid of a row: who, where to and when, how long and how far, the breaks, the state. */
const ROW_GRID =
  "lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1.7fr)_minmax(0,0.9fr)_minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:gap-4";

function Row({ item, onOpen }: { item: JourneyListItem; onOpen: (id: number) => void }) {
  const active = item.status === "active";
  return (
    <div
      data-testid="journey-row"
      data-journey-id={item.id}
      data-status={item.status}
      className={cn(
        ROW_GRID,
        "cursor-pointer space-y-2.5 border-b border-slate-100 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-slate-50/70 lg:space-y-0",
      )}
      onClick={() => onOpen(item.id)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={item.employeeName} size={40} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-gray-900">{item.employeeName}</p>
          <p className="truncate text-xs text-gray-500">
            <span className="font-mono">{item.employeeCode}</span> · {item.department ?? "No department"}
          </p>
        </div>
      </div>

      <div className="min-w-0">
        <button
          type="button"
          className="block max-w-full truncate text-left text-sm font-semibold text-[#006496] hover:underline"
          aria-label={`Open the journey of ${item.employeeName} to ${item.destination}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(item.id);
          }}
        >
          {item.destination || "No destination"}
        </button>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-600">
          <CalendarDays size={11} className="shrink-0 text-slate-400" />
          <span className="whitespace-nowrap">{fmtDateTime(item.startedAt)}</span>
          <span aria-hidden>→</span>
          {active ? (
            <span className="font-semibold text-emerald-700">now</span>
          ) : (
            <span className="whitespace-nowrap">{fmtDateTime(item.endedAt)}</span>
          )}
        </p>
        {!active && <p className="text-[11px] text-slate-500">{endReasonLabel(item.endReason, item.status)}</p>}
      </div>

      <div>
        <p className="flex items-center gap-1.5 text-sm font-bold tabular-nums text-gray-900">
          <Timer size={12} className="text-slate-400" />
          {fmtDuration(item.durationS)}
        </p>
        <p className="flex items-center gap-1.5 text-xs tabular-nums text-gray-600">
          <RouteIcon size={12} className="text-slate-400" />
          {fmtDistance(item.distanceM)}
        </p>
      </div>

      <div className="text-xs text-gray-600">
        <p className="flex items-center gap-1.5">
          <Coffee size={12} className="text-amber-500" />
          <span className="font-bold text-gray-900">
            {item.stopCount} {item.stopCount === 1 ? "break" : "breaks"}
          </span>
          {item.stopCount > 0 && <span>· {fmtDuration(item.stopS)}</span>}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {item.stopCount > 0 ? `longest ${fmtDuration(item.longestStopS)}` : "no stop recorded"}
          {item.gapS > 0 ? ` · ${fmtDuration(item.gapS)} no location` : ""}
          {item.eventsCount > 0 ? ` · ${item.eventsCount} ${item.eventsCount === 1 ? "event" : "events"}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {active ? (
          <>
            <LiveBadge />
            <StatePill state={item.state} testId="row-state" />
          </>
        ) : (
          <Chip className="bg-gray-100 text-gray-700">Ended</Chip>
        )}
        <ApprovalChip status={item.approvalStatus} />
        {item.hasMock && (
          <Chip testId="mock-flag" className="bg-red-50 text-red-700">
            <AlertTriangle size={11} /> Simulated
          </Chip>
        )}
      </div>
    </div>
  );
}

export default function JourneyList({
  filters,
  onFilters,
  onOpen,
}: {
  filters: JourneyFilters;
  onFilters: (patch: Partial<JourneyFilters>) => void;
  onOpen: (id: number) => void;
}) {
  const badRange = filters.from !== "" && filters.to !== "" && filters.from > filters.to;
  const query = useJourneys(
    {
      employeeId: filters.employee?.id ?? null,
      from: filters.from,
      to: filters.to,
      status: filters.status,
      endReason: filters.endReason,
      page: filters.page,
      pageSize: filters.pageSize,
    },
    !badRange,
  );

  // The end reason is also sent to the server; checking it here as well keeps the page right if the server does not know it.
  const rows = useMemo(
    () => (query.data?.results ?? []).filter((r) => sameReason(r, filters.endReason)),
    [query.data, filters.endReason],
  );
  // rows that do not match came back: the server did not apply the end-reason filter, so only this page was narrowed
  const reasonOnPageOnly =
    filters.endReason !== "" &&
    !query.isPlaceholderData &&
    (query.data?.results ?? []).some((r) => !sameReason(r, filters.endReason));
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const loading = query.isPending && !badRange;
  const filtered = filtersAreSet(filters);

  const liveNow = rows.filter((r) => r.status === "active");

  return (
    <div className="space-y-4" data-testid="journey-list">
      <section className="clay-card rounded-2xl border border-slate-100 p-3.5 sm:p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="journey-employee" className="mb-1 block text-xs font-semibold text-gray-600">
              Employee
            </label>
            <EmployeePicker value={filters.employee} onChange={(employee) => onFilters({ employee, page: 1 })} />
          </div>
          <div>
            <label htmlFor="journey-from" className="mb-1 block text-xs font-semibold text-gray-600">
              From
            </label>
            <Input
              id="journey-from"
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => onFilters({ from: e.target.value, page: 1 })}
              className="h-9 text-sm"
            />
          </div>
          <div>
            <label htmlFor="journey-to" className="mb-1 block text-xs font-semibold text-gray-600">
              To
            </label>
            <Input
              id="journey-to"
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => onFilters({ to: e.target.value, page: 1 })}
              className="h-9 text-sm"
            />
          </div>
          <div>
            <label htmlFor="journey-status" className="mb-1 block text-xs font-semibold text-gray-600">
              Status
            </label>
            <select
              id="journey-status"
              className={SELECT_CLASS}
              value={filters.status}
              onChange={(e) => onFilters({ status: e.target.value as JourneyFilters["status"], page: 1 })}
            >
              <option value="">All journeys</option>
              <option value="active">Active (live)</option>
              <option value="ended">Ended</option>
            </select>
          </div>
          <div>
            <label htmlFor="journey-reason" className="mb-1 block text-xs font-semibold text-gray-600">
              How it ended
            </label>
            <select
              id="journey-reason"
              className={SELECT_CLASS}
              value={filters.endReason}
              onChange={(e) => onFilters({ endReason: e.target.value, page: 1 })}
            >
              <option value="">Any reason</option>
              {END_REASONS.map((r) => (
                <option key={r} value={r}>
                  {END_REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {badRange && (
          <p role="alert" className="mt-2 text-xs font-medium text-red-600" data-testid="range-error">
            The "From" date is after the "To" date: no journey can match. Change one of them.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
          <p className="text-xs text-gray-500">
            Every On-Duty request is tracked from the moment it is submitted. Times are India time (IST).
          </p>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => onFilters({ ...DEFAULT_FILTERS, pageSize: filters.pageSize })}
            >
              <RotateCcw size={12} /> Clear filters
            </Button>
          )}
        </div>
      </section>

      {liveNow.length > 0 && <LiveNow items={liveNow} onOpen={onOpen} />}

      <SectionCard
        title="Journeys"
        description={total > 0 ? `${total} ${total === 1 ? "journey" : "journeys"}, newest first` : "Newest first"}
        icon={RouteIcon}
        className="overflow-hidden"
        bodyClassName="p-0 pt-3"
      >
        {loading ? (
          <div className="space-y-2 p-4" data-testid="journey-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        ) : query.isError && !query.data ? (
          <EmptyNote icon={<AlertTriangle size={30} />} testId="journey-error">
            <p className="font-semibold text-gray-700">
              {isTrackingForbidden(query.error)
                ? "You are not allowed to see journeys."
                : "The journeys could not be loaded."}
            </p>
            <p className="mt-1">{trackingErrorMessage(query.error, "Check the connection and try again.")}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </EmptyNote>
        ) : rows.length === 0 ? (
          <EmptyNote icon={<RouteIcon size={30} />} testId="journey-empty">
            {filtered ? (
              <p>No journey matches these filters.</p>
            ) : (
              <>
                <p className="font-semibold text-gray-700">No journeys yet.</p>
                <p className="mt-1">
                  A journey starts when an employee submits an On-Duty request, and it appears here with its route,
                  stops and events.
                </p>
              </>
            )}
          </EmptyNote>
        ) : (
          <>
            <div
              className={cn(
                ROW_GRID,
                "hidden border-y border-slate-100 bg-slate-50/80 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500",
              )}
              aria-hidden
            >
              <span>Employee</span>
              <span>Destination and time</span>
              <span>Time and distance</span>
              <span>Breaks</span>
              <span>Status</span>
            </div>
            <div>
              {rows.map((item) => (
                <Row key={item.id} item={item} onOpen={onOpen} />
              ))}
            </div>
            {reasonOnPageOnly && (
              <p className="border-t px-4 py-2 text-xs text-gray-600" data-testid="reason-note">
                The server did not narrow the list by how the journeys ended, so only the journeys of this page that
                match are shown. Other pages may hold more.
              </p>
            )}
            <div className="border-t border-slate-100 px-4">
              <DataPagination
                page={Math.min(filters.page, totalPages)}
                totalPages={totalPages}
                onPageChange={(page) => onFilters({ page })}
                pageSize={filters.pageSize}
                onPageSizeChange={(pageSize) => onFilters({ pageSize, page: 1 })}
                totalItems={total}
              />
            </div>
          </>
        )}
      </SectionCard>
      <p className="flex items-center gap-1.5 px-1 text-xs text-gray-500">
        <MapPinned size={12} /> Open a journey to see its route on the map, every break and every event.
      </p>
    </div>
  );
}
