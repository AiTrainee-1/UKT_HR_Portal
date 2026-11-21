// The gate's own records on the gate monitor: dates (Today / This week / This month / any two days), type, result and a
// search, one page at a time, and the same rows as an Excel or PDF file. Always this gate only: the server ignores any
// gate the address names, so there is no gate filter here. Filters live in the address, like the HR lists.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import type { GateMonitorRecord } from "@/lib/api-client/custom-hooks/gate-monitor";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type DataColumn } from "@/pages/hr/outpass-visitors/kit/DataTable";
import { DateRangeFilter } from "@/pages/hr/outpass-visitors/kit/DateRangeFilter";
import { ExportButton } from "@/pages/hr/outpass-visitors/kit/ExportButton";
import { ClearFilters, FilterBar, SearchFilter, SelectFilter } from "@/pages/hr/outpass-visitors/kit/FilterBar";
import { PersonCell } from "@/pages/hr/outpass-visitors/kit/PersonCell";
import { StatusChip } from "@/pages/hr/outpass-visitors/kit/StatusChip";
import { useGateFilters } from "@/pages/hr/outpass-visitors/kit/useGateFilters";
import { WhenCell } from "@/pages/hr/outpass-visitors/kit/WhenCell";
import { fmtCount, fmtMinutes, fmtRangeLabel, NONE } from "@/pages/hr/outpass-visitors/kit/fmt";
import { gateExport, gateRecords, GateSessionEndedError } from "./client";
import { CARD } from "./parts";

const DEFAULTS = { range: "today", from: "", to: "", type: "", result: "", q: "", pageSize: "25" };

const TYPE_OPTIONS = [
  { value: "exit", label: "Exits" },
  { value: "return", label: "Returns" },
  { value: "tea_out", label: "Tea break out" },
  { value: "tea_in", label: "Tea break in" },
] as const;

const RESULT_OPTIONS = [
  { value: "allowed", label: "Allowed" },
  { value: "denied", label: "Denied" },
] as const;

const TYPE_LABEL: Record<string, string> = {
  exit: "Exit",
  return: "Return",
  tea_out: "Tea break out",
  tea_in: "Tea break in",
};

const COLUMNS: DataColumn<GateMonitorRecord>[] = [
  { key: "at", header: "Time", cell: (r) => <WhenCell value={r.at} />, truncate: false, minWidth: 96 },
  { key: "type", header: "Type", cell: (r) => TYPE_LABEL[r.type] ?? r.type, text: (r) => TYPE_LABEL[r.type] ?? r.type },
  {
    key: "result",
    header: "Result",
    cell: (r) =>
      r.result === "denied" ? (
        <StatusChip tone="rose" title={r.reasonLabel ?? undefined}>
          {r.reasonLabel ? `Denied · ${r.reasonLabel}` : "Denied"}
        </StatusChip>
      ) : (
        <StatusChip tone="teal">Allowed</StatusChip>
      ),
    truncate: false,
  },
  {
    key: "employee",
    header: "Employee",
    cell: (r) =>
      r.employee ? (
        <PersonCell
          name={r.employee.name}
          code={r.employee.employeeCode}
          sub={r.employee.department}
          photoUrl={r.employee.photoUrl}
        />
      ) : (
        <span className="text-slate-500">Unknown code</span>
      ),
    text: (r) => (r.employee ? `${r.employee.name} (${r.employee.employeeCode})` : "Unknown code"),
    minWidth: 200,
    maxWidth: 260,
  },
  {
    key: "detail",
    header: "Details",
    cell: (r) => r.destination || r.message || NONE,
    text: (r) => [r.destination, r.message].filter(Boolean).join(" - "),
    maxWidth: 320,
    hideOnPhone: true,
  },
  {
    key: "minutes",
    header: "Break",
    cell: (r) => (typeof r.minutes === "number" ? fmtMinutes(r.minutes) : NONE),
    align: "right",
    hideOnPhone: true,
  },
];

export function RecordsView() {
  const { toast } = useToast();
  const f = useGateFilters(DEFAULTS);
  const query = useQuery({
    queryKey: ["gate-monitor", "records", f.queryKey],
    queryFn: ({ signal }) => gateRecords(f.params, signal),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 15_000,
  });
  const data = query.data;
  const counts = data?.counts;
  const ended = query.error instanceof GateSessionEndedError;
  const summary = counts
    ? `${fmtCount(data.total)} ${data.total === 1 ? "record" : "records"} · ${fmtCount(counts.exits)} exits · ${fmtCount(
        counts.returns,
      )} returns · ${fmtCount(counts.teaOut)} tea breaks · ${fmtCount(counts.denied)} denied`
    : null;

  const download = async (format: "xlsx" | "pdf") => {
    const filename = await gateExport(format, f.exportQuery);
    toast({ title: "File downloaded", description: filename });
  };

  return (
    // a light sheet on the kiosk's dark page: the filters and the table are the HR kit's, drawn for a light background
    <section
      aria-labelledby="gate-records-title"
      className="gk-light gk-enter flex min-w-0 flex-col gap-3 rounded-3xl border border-white/10 bg-slate-50 p-3 text-slate-900 sm:p-5"
      data-testid="gate-records"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="gate-records-title" className="text-lg font-bold text-slate-900">
          Gate records
        </h2>
        <p className="text-sm text-slate-600">
          {fmtRangeLabel(f.dateRange.from, f.dateRange.to)} · You see only this gate's records.
        </p>
      </div>
      <FilterBar
        label="Record filters"
        actions={
          <ExportButton
            title="Gate records"
            run={download}
            hints={{ xlsx: "Every matching row, up to 30,000", pdf: "Every matching row, up to 5,000" }}
            testId="records-export"
          />
        }
      >
        <DateRangeFilter
          range={f.filters.range}
          from={f.filters.from}
          to={f.filters.to}
          onChange={(patch) => f.set(patch)}
        />
        <SelectFilter
          label="Type"
          value={f.filters.type}
          onChange={(type) => f.set({ type })}
          options={TYPE_OPTIONS}
          allLabel="All types"
          testId="records-type"
        />
        <SelectFilter
          label="Result"
          value={f.filters.result}
          onChange={(result) => f.set({ result })}
          options={RESULT_OPTIONS}
          allLabel="All results"
          testId="records-result"
        />
        <SearchFilter
          value={f.filters.q}
          onChange={(q) => f.set({ q })}
          placeholder="Name, code or destination"
          label="Search records"
          testId="records-search"
        />
        <ClearFilters count={f.activeCount} onClear={f.clear} />
      </FilterBar>
      <div className={CARD}>
        <DataTable
          columns={COLUMNS}
          rows={data?.items}
          rowKey={(r) => r.id}
          loading={query.isLoading}
          error={query.error && !ended ? (query.error as Error).message : null}
          onRetry={() => void query.refetch()}
          empty={{
            icon: ClipboardList,
            title: "No records for these filters",
            hint: "Try other dates, or clear the filters.",
          }}
          summary={summary}
          pagination={
            data
              ? {
                  page: data.page,
                  pageSize: data.pageSize,
                  total: data.total,
                  onPageChange: f.setPage,
                  onPageSizeChange: (size) => f.set({ pageSize: String(size) }),
                }
              : undefined
          }
          caption="This gate's records"
          testId="records-table"
        />
      </div>
    </section>
  );
}
