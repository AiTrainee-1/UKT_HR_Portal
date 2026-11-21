import { useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { CalendarRange, ClipboardCheck, Search, UserCog, X } from "lucide-react";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { MonthPicker, monthLabel, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { EmptyBlock, ErrorBanner, SkeletonBlock } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { Input } from "@/components/ui/input";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { monthFromParams, oneOf, pageFromParams, useUrlParams } from "@/lib/md/url-filters";
import { cn } from "@/lib/utils";
import { useHodRequests, useMdHods } from "./approvals/api";
import HodSummary from "./approvals/HodSummary";
import {
  filterItems,
  hodIdFromPath,
  hodLabel,
  hodPath,
  isKindFilter,
  KIND_NAMES,
  kindOptions,
  overviewOf,
  pageCount,
  pageSlice,
  pickHod,
  STATUS_OPTIONS,
  type KindFilter,
} from "./approvals/logic";
import Overview from "./approvals/Overview";
import Pagination from "./approvals/Pagination";
import { Pills } from "./approvals/parts";
import RequestCard from "./approvals/RequestCard";
import RequestDetails from "./approvals/RequestDetails";
import type { RequestStatusFilter } from "./approvals/types";

const STATUSES: RequestStatusFilter[] = ["pending", "approved", "rejected", "all"];

const EMPTY_TEXT: Record<RequestStatusFilter, string> = {
  pending: "Nothing is waiting for this Department Head right now.",
  approved: "No approved requests yet.",
  rejected: "No rejected requests.",
  all: "No requests have been sent to this Department Head yet.",
};

/**
 * HOD Approvals: the requests sent to the Department Heads who work in the MD department, one page per head, so the MD can
 * follow and decide them without signing in as each head. The heads come from User Management (an employee of the MD
 * department who is an active Department Head); a decision runs the head's own approval at the head's step
 * (api/md_portal/hod_approvals.py). The heads are picked in the sidebar (owner, 2026-11-14: no row of head tabs here);
 * /md/approvals alone shows the first head.
 *
 * 2026-11-21: an overview first (waiting now, what came in and how it was decided, by kind, six months), then the list
 * with its filters - status (the server's), type of request, month, search - all kept in the address; every request shows
 * its request date, the date(s) it is for, the moment it was sent and its reason, and opens its full details on click.
 */
export default function MdApprovals() {
  const [location, navigate] = useLocation();
  const [params, update] = useUrlParams();
  const status = oneOf(params, "status", STATUSES, "pending");
  const kindParam = params.get("kind");
  const kind: KindFilter = isKindFilter(kindParam) ? kindParam : "all";
  const month = monthFromParams(params);
  const q = params.get("q") ?? "";
  const openKey = params.get("request");

  const hodsQuery = useMdHods();
  const hods = useMemo(() => hodsQuery.data?.hods ?? [], [hodsQuery.data]);
  const fromPath = hodIdFromPath(location);
  const hod = pickHod(hods, fromPath);
  const requests = useHodRequests(hod?.id, status);
  const history = useHodRequests(hod?.id, "all");

  // the list on screen belongs to this head and status (not the previous one still shown while the new one loads)
  const current = requests.data?.hod.id === hod?.id && requests.data?.status === status;
  const serverItems = useMemo(() => (current ? (requests.data?.items ?? []) : []), [current, requests.data]);
  const monthItems = useMemo(() => filterItems(serverItems, { kind: "all", month, q }), [serverItems, month, q]);
  const items = useMemo(() => filterItems(serverItems, { kind, month, q }), [serverItems, kind, month, q]);
  const historyItems = useMemo(
    () => (history.data && history.data.hod.id === hod?.id ? history.data.items : undefined),
    [history.data, hod?.id],
  );
  const overview = useMemo(() => (historyItems ? overviewOf(historyItems, month) : undefined), [historyItems, month]);
  const openItem = openKey ? (historyItems ?? serverItems).find((i) => i.key === openKey) : undefined;

  // 10 requests a page; a page emptied by decisions shows the last one that still has rows
  const page = Math.min(pageFromParams(params), pageCount(items.length));
  const shown = pageSlice(items, page);
  const listTop = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => {
    update({ page: next > 1 ? next : null });
    const top = listTop.current;
    if (top && top.getBoundingClientRect().top < 0) {
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      top.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    }
  };
  // a filter change starts again at page 1
  const setFilter = (patch: Record<string, string | null>) => update({ ...patch, page: null });
  const setStatus = (next: RequestStatusFilter) => setFilter({ status: next === "pending" ? null : next });
  const setKind = (next: KindFilter) => setFilter({ kind: next === "all" ? null : next });
  const setMonth = (next: string | null) => setFilter({ month: next });

  // a head who left the MD department (or an old link): show the first head instead, at its own address
  useEffect(() => {
    if (hodsQuery.isSuccess && fromPath !== null && hod && hod.id !== fromPath)
      navigate(hodPath(hod.id), { replace: true });
  }, [hodsQuery.isSuccess, fromPath, hod, navigate]);

  usePublishAssistantContext({
    page: "approvals",
    title: "HOD Approvals",
    filters: {
      "Department Head": hod?.name ?? "none",
      Status: status,
      Type: kind === "all" ? "All" : KIND_NAMES[kind],
      Month: month ? monthLabel(month) : "All months",
      ...(q ? { Search: q } : {}),
    },
    summary: {
      "Department Heads": String(hods.length),
      "Waiting for this head": hod ? String(hod.pending.total) : "0",
      ...(overview
        ? {
            "Requests in the month": String(overview.received),
            Approved: String(overview.approved),
            Rejected: String(overview.rejected),
          }
        : {}),
    },
  });

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1200px] space-y-5 pb-6 @container sm:pb-24" data-testid="md-approvals-page">
        <MdPageHeader
          icon={ClipboardCheck}
          title="HOD Approvals"
          subtitle="Requests sent to the Department Heads of the MD department. Decide them here, at the Department Head's step."
        />

        {hodsQuery.isError ? (
          <ErrorBanner message={describeMdError(hodsQuery.error)} onRetry={() => hodsQuery.refetch()} />
        ) : hodsQuery.isLoading ? (
          <div className="md-card p-5">
            <SkeletonBlock rows={4} />
          </div>
        ) : hods.length === 0 ? (
          <div className="md-card" data-testid="md-approvals-empty">
            <EmptyBlock icon={UserCog} title="No Department Head in the MD department yet">
              Add the employee to the{" "}
              {hodsQuery.data?.mdDepartments.length ? `"${hodsQuery.data.mdDepartments[0].name}"` : "MD"} department,
              then make them a Department Head in HR → User Management. They appear in the sidebar under HOD Approvals,
              with their requests, by themselves.
              {hodsQuery.data &&
                hodsQuery.data.mdDepartments.length === 0 &&
                " There is no department called MD yet: create it in HR → Departments first."}
            </EmptyBlock>
          </div>
        ) : (
          hod && (
            <section
              aria-label={hodLabel(hod)}
              className="md-card space-y-5 p-4 @2xl:p-6"
              data-testid="md-approvals-panel"
              data-hod={hod.id}
            >
              <HodSummary hod={hod} />
              <div className="border-t border-md-line pt-4">
                <Overview
                  hod={hod}
                  overview={overview}
                  month={month}
                  loading={history.isFetching}
                  onStatus={setStatus}
                  onKind={setKind}
                  onMonth={(m) => setMonth(m === month ? null : m)}
                />
              </div>

              <div ref={listTop} className="scroll-mt-4 space-y-3 border-t border-md-line pt-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5" data-testid="md-approvals-filters">
                  <div className="max-w-full overflow-x-auto">
                    <Pills
                      label="Status"
                      value={status}
                      options={STATUS_OPTIONS}
                      onChange={setStatus}
                      testId="md-approvals-status"
                    />
                  </div>
                  <div className="flex max-w-full flex-wrap items-center gap-2" data-testid="md-approvals-month">
                    <CalendarRange size={15} className="text-md-ink-soft" aria-hidden="true" />
                    <MonthPicker value={month ?? thisMonthKey()} onChange={(m) => setMonth(m)} label="Month" />
                    <button
                      type="button"
                      onClick={() => setMonth(null)}
                      aria-pressed={!month}
                      className={cn("md-btn md-btn-sm", month ? "md-btn-ghost" : "md-btn-soft")}
                      data-testid="md-approvals-all-months"
                    >
                      All months
                    </button>
                  </div>
                  <div className="relative w-full sm:w-64">
                    <Search
                      size={15}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-md-ink-soft"
                      aria-hidden="true"
                    />
                    <Input
                      value={q}
                      onChange={(e) => setFilter({ q: e.target.value || null })}
                      placeholder="Search name, code or reason"
                      aria-label="Search requests"
                      className="md-field h-9 pl-9 pr-9 text-xs"
                      data-testid="md-approvals-search"
                    />
                    {q && (
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setFilter({ q: null })}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-md-ink-soft hover:text-md-ink"
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="max-w-full overflow-x-auto pb-0.5">
                  <Pills
                    label="Type of request"
                    value={kind}
                    options={kindOptions(monthItems, kind)}
                    onChange={setKind}
                    testId="md-approvals-kind"
                  />
                </div>
              </div>

              {requests.isError ? (
                <ErrorBanner message={describeMdError(requests.error)} onRetry={() => requests.refetch()} />
              ) : !current && requests.isFetching ? (
                <SkeletonBlock rows={4} />
              ) : items.length === 0 ? (
                <EmptyBlock
                  title={
                    serverItems.length === 0
                      ? EMPTY_TEXT[status]
                      : "No request matches these filters. Try another month, type or search."
                  }
                />
              ) : (
                <ul className="space-y-3" aria-label={`Requests for ${hodLabel(hod)}`} data-testid="md-approvals-list">
                  {shown.map((item) => (
                    <li key={item.key}>
                      <RequestCard
                        item={item}
                        hod={hod}
                        onDetails={(it) => update({ request: it.key }, { push: true })}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {current && items.length > 0 && <Pagination total={items.length} page={page} onPage={goToPage} />}
              <RequestDetails item={openItem} hod={hod} open={!!openKey} onClose={() => update({ request: null })} />
            </section>
          )
        )}
      </div>
    </MdLayout>
  );
}
