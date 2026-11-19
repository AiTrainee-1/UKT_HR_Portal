import { useMemo, useState } from "react";
import { ClipboardList } from "lucide-react";
import type { VisitorVisit } from "@/lib/api-client/custom-hooks";
import { useToast } from "@/hooks/use-toast";
import { DataTable } from "@/pages/hr/outpass-visitors/kit/DataTable";
import { DateRangeFilter } from "@/pages/hr/outpass-visitors/kit/DateRangeFilter";
import { ExportButton } from "@/pages/hr/outpass-visitors/kit/ExportButton";
import { ClearFilters, FilterBar, SearchFilter, SelectFilter } from "@/pages/hr/outpass-visitors/kit/FilterBar";
import { useGateFilters } from "@/pages/hr/outpass-visitors/kit/useGateFilters";
import { fmtCount, fmtRangeLabel } from "@/pages/hr/outpass-visitors/kit/fmt";
import { STATUS_OPTIONS } from "@/pages/hr/outpass-visitors/visitors/logic";
import { deskExport, sessionEnded, useDeskRecords } from "./desk-api";
import { visitColumns } from "./visit-columns";

/** The records view's filters (in the address): any two days, the status and a search. Always this desk's branch. */
const DEFAULTS = { range: "today", from: "", to: "", status: "", q: "", pageSize: "25" };

/**
 * The desk's records: this branch's visits for any dates (Today / This week / This month / any two days), a status and
 * a search, one page at a time, and the same rows as an Excel or PDF file (the desk's own token; the Aadhaar number only
 * masked in the file). A visitor still inside can be checked out from here too.
 */
export function DeskRecordsView({ onCheckOut }: { onCheckOut: (visit: VisitorVisit) => void }) {
  const { toast } = useToast();
  const f = useGateFilters(DEFAULTS);
  const query = useDeskRecords(f.params, f.queryKey);
  const [shownAadhaar, setShownAadhaar] = useState<number | null>(null);
  const data = query.data;
  const ended = sessionEnded(query.error);
  const now = new Date();
  const columns = useMemo(
    () =>
      visitColumns({
        now,
        shownAadhaar,
        onToggleAadhaar: (id) => setShownAadhaar((cur) => (cur === id ? null : id)),
        onCheckOut,
        withCheckedInBy: true,
      }),
    // `now` is read for the "today" check of each time; it is fresh on every render that changes the rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownAadhaar, onCheckOut, data],
  );

  const download = async (format: "xlsx" | "pdf") => {
    try {
      const filename = await deskExport(format, f.exportQuery);
      toast({ title: "File downloaded", description: filename });
    } catch (err) {
      if (sessionEnded(err)) return; // on its way to the sign-in page
      throw err;
    }
  };

  return (
    <section aria-labelledby="desk-records-title" className="flex min-w-0 flex-col gap-3" data-testid="desk-records">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="desk-records-title" className="text-lg font-bold text-slate-900">
          Visitor records
        </h2>
        <p className="text-sm text-slate-500">
          {fmtRangeLabel(f.dateRange.from, f.dateRange.to)} · Visitors of this desk's branch only.
        </p>
      </div>
      <FilterBar
        label="Record filters"
        testId="desk-records-filters"
        actions={
          <ExportButton
            title="Visitors"
            run={download}
            hints={{ xlsx: "Every matching visit, up to 30,000", pdf: "Up to 5,000 visits" }}
            testId="desk-records-export"
          />
        }
      >
        <DateRangeFilter
          range={f.filters.range}
          from={f.filters.from}
          to={f.filters.to}
          onChange={(patch) => f.set(patch)}
          testId="desk-records-dates"
        />
        <SelectFilter
          label="Status"
          value={f.filters.status}
          onChange={(status) => f.set({ status })}
          options={STATUS_OPTIONS}
          allLabel="Every status"
          testId="desk-records-status"
        />
        <SearchFilter
          value={f.filters.q}
          onChange={(q) => f.set({ q })}
          placeholder="Name, phone, company or host"
          label="Search visitors by name, phone, company, host or purpose"
          testId="desk-records-search"
        />
        <ClearFilters count={f.activeCount} onClear={f.clear} testId="desk-records-clear" />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(v) => v.id}
        loading={query.isLoading}
        error={query.error && !ended ? (query.error as Error).message : null}
        onRetry={() => void query.refetch()}
        empty={{
          icon: ClipboardList,
          title: "No visitors for these filters",
          hint: "Try other dates, or clear the filters.",
        }}
        summary={
          data ? (
            <span data-testid="desk-records-summary">
              {fmtCount(data.total)} {data.total === 1 ? "visit" : "visits"}
            </span>
          ) : null
        }
        pagination={
          data
            ? {
                page: data.page,
                pageSize: data.pageSize,
                total: data.total,
                onPageChange: f.setPage,
                onPageSizeChange: (size) => f.set({ pageSize: String(size) }),
                pageSizes: [25, 50, 100],
              }
            : undefined
        }
        caption="This branch's visitors"
        testId="desk-records-table"
      />
    </section>
  );
}
