import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ClipboardCheck, UserCog } from "lucide-react";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { EmptyBlock, ErrorBanner, SkeletonBlock } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { useHodRequests, useMdHods } from "./approvals/api";
import HodSummary from "./approvals/HodSummary";
import {
  filterByGroup,
  groupOptions,
  GROUP_LABELS,
  hodIdFromPath,
  hodLabel,
  hodPath,
  pageCount,
  pageSlice,
  pickHod,
  STATUS_OPTIONS,
  type GroupFilter,
} from "./approvals/logic";
import Pagination from "./approvals/Pagination";
import RequestCard from "./approvals/RequestCard";
import type { RequestStatusFilter } from "./approvals/types";
import { Pills } from "./home/parts";

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
 * (api/md_portal/hod_approvals.py). The heads are picked in the sidebar, which lists them under this page with what waits
 * for each (owner, 2026-11-14: no row of head tabs on the page itself); /md/approvals alone shows the first head.
 */
export default function MdApprovals() {
  const [location, navigate] = useLocation();
  const [status, setStatus] = useState<RequestStatusFilter>("pending");
  const hodsQuery = useMdHods();
  const hods = useMemo(() => hodsQuery.data?.hods ?? [], [hodsQuery.data]);
  const fromPath = hodIdFromPath(location);
  const hod = pickHod(hods, fromPath);
  // the type of request picked is this head's: another head (from the sidebar) starts again at "All"
  const [groupPick, setGroupPick] = useState<{ hodId: number | undefined; group: GroupFilter }>({
    hodId: undefined,
    group: "all",
  });
  const group: GroupFilter = groupPick.hodId === hod?.id ? groupPick.group : "all";
  const setGroup = (next: GroupFilter) => setGroupPick({ hodId: hod?.id, group: next });
  const requests = useHodRequests(hod?.id, status);
  const items = filterByGroup(requests.data?.items ?? [], group);
  const counts = requests.data?.counts ?? { leave: 0, permission: 0, other: 0, total: 0 };
  // the list on screen belongs to this head and filter (not the previous one still shown while the new one loads)
  const current = requests.data?.hod.id === hod?.id && requests.data?.status === status;
  // 10 requests a page; another head, status or type starts again at page 1, and a page emptied by decisions shows the
  // last one that still has rows
  const listKey = `${hod?.id}|${status}|${group}`;
  const [paging, setPaging] = useState({ key: listKey, page: 1 });
  const page = Math.min(paging.key === listKey ? paging.page : 1, pageCount(items.length));
  const shown = pageSlice(items, page);
  const listTop = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => {
    setPaging({ key: listKey, page: next });
    const top = listTop.current;
    if (top && top.getBoundingClientRect().top < 0) {
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      top.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    }
  };

  // a head who left the MD department (or an old link): show the first head instead, at its own address
  useEffect(() => {
    if (hodsQuery.isSuccess && fromPath !== null && hod && hod.id !== fromPath)
      navigate(hodPath(hod.id), { replace: true });
  }, [hodsQuery.isSuccess, fromPath, hod, navigate]);

  usePublishAssistantContext({
    page: "approvals",
    title: "HOD Approvals",
    filters: { "Department Head": hod?.name ?? "none", Status: status, Type: GROUP_LABELS[group] },
    summary: {
      "Department Heads": String(hods.length),
      "Waiting for this head": hod ? String(hod.pending.total) : "0",
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
              className="md-card space-y-5 p-5 @2xl:p-6"
              data-testid="md-approvals-panel"
              data-hod={hod.id}
            >
              <HodSummary hod={hod} />
              {/* each switch scrolls sideways on a phone rather than squeezing its words onto several lines */}
              <div
                ref={listTop}
                className="flex scroll-mt-4 flex-wrap items-center gap-3 border-t border-md-line pt-4 [&_button]:whitespace-nowrap"
              >
                <div className="max-w-full overflow-x-auto">
                  <Pills
                    label="Status"
                    value={status}
                    options={STATUS_OPTIONS}
                    onChange={setStatus}
                    testId="md-approvals-status"
                  />
                </div>
                <div className="max-w-full overflow-x-auto">
                  <Pills
                    label="Type of request"
                    value={group}
                    options={groupOptions(counts)}
                    onChange={setGroup}
                    testId="md-approvals-group"
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
                    group === "all" ? EMPTY_TEXT[status] : `No ${GROUP_LABELS[group].toLowerCase()} requests here.`
                  }
                />
              ) : (
                <ul className="space-y-3" aria-label={`Requests for ${hodLabel(hod)}`} data-testid="md-approvals-list">
                  {shown.map((item) => (
                    <li key={item.key}>
                      <RequestCard item={item} hod={hod} />
                    </li>
                  ))}
                </ul>
              )}
              {current && items.length > 0 && <Pagination total={items.length} page={page} onPage={goToPage} />}
            </section>
          )
        )}
      </div>
    </MdLayout>
  );
}
