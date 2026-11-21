import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayShort, num } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { personSecondary } from "./logic";
import type { PeopleAsk, PeopleList } from "./types";

// Pieces the Employees, Branches and Manage Shift Insights share (all three are this helper's): the dimmed-while-loading
// class, a card's error, and the people drill-down sheet.

/** A card whose request failed: what the server said, and a retry. The other cards are unaffected. */
export function QueryError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** While a changed filter loads the old figures stay (the page never blanks); this dims them meanwhile. */
export function refreshing(...queries: UseQueryResult<unknown>[]): string {
  return queries.some((q) => q.isFetching && !q.isPending) ? "opacity-60 transition-opacity" : "transition-opacity";
}

/** Previous / next for a paged drill-down list. */
export function Pager({
  page,
  pages,
  total,
  onPage,
  testId,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
  testId: string;
}) {
  if (pages <= 1) return null;
  const btn = "md-btn inline-flex h-8 w-8 items-center justify-center rounded-lg text-md-ink-soft disabled:opacity-40";
  return (
    <div
      className="flex items-center justify-between gap-2 text-xs font-semibold text-md-ink-soft"
      data-testid={testId}
    >
      <span>
        Page {page} of {pages} · {num(total)} in all
      </span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          className={btn}
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
        >
          <ChevronRight size={14} aria-hidden />
        </button>
      </span>
    </div>
  );
}

const PAGE_SIZE = 25;

/**
 * The people behind a figure (GET /api/md/employees/people): a page at a time, each person opening their record, and a
 * way on to the HR page. `params` are the tab's filters (month or range, unit, department, type).
 */
export function PeopleSheet({
  ask,
  params,
  onClose,
  testId = "md-people-sheet",
}: {
  ask: PeopleAsk | null;
  params: MdQueryParams;
  onClose: () => void;
  testId?: string;
}) {
  const open = useOpenInPage();
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState<PeopleAsk | null>(ask);
  if (ask && ask !== shown) {
    setShown(ask);
    setPage(1);
  }
  const current = ask ?? shown;
  const query = useMdQuery<PeopleList>(
    "employees/people",
    current
      ? { ...params, ...(current.extra ?? {}), group: current.group, value: current.value, page, pageSize: PAGE_SIZE }
      : undefined,
    { enabled: ask != null },
  );
  const data = query.data;
  const dated = current?.group === "joiners" || current?.group === "leavers" || current?.group === "early";
  return (
    <DetailSheet
      open={ask != null}
      onClose={onClose}
      title={current?.title ?? "People"}
      subtitle={
        current
          ? `${current.subtitle ? `${current.subtitle} · ` : ""}${data ? `${num(data.total)} ${data.total === 1 ? "person" : "people"}` : ""}`
          : undefined
      }
      loading={query.isPending || (query.isPlaceholderData && query.isFetching)}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "Nobody matches this figure for the chosen filters." : null}
      openLabel={current?.open?.label}
      onOpen={current?.open ? () => open(current.open!.path) : undefined}
      testId={testId}
      wide
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId={`${testId}-rows`}>
            {data.rows.map((r) => (
              <DetailRow
                key={r.id}
                testId={`${testId}-row-${r.id}`}
                primary={`${r.name} · ${r.code}`}
                secondary={personSecondary(r)}
                value={
                  dated
                    ? dayShort(current?.group === "joiners" ? r.joinDate : r.leftOn)
                    : (r.factoryLabel ?? r.cycle ?? r.tenure ?? undefined)
                }
                onClick={() => open(employeeAddress(r.id))}
              />
            ))}
          </DetailList>
          <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} testId={`${testId}-pager`} />
        </div>
      )}
    </DetailSheet>
  );
}
