import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { minutesText } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { periodPhrase, rangeText, stampText } from "./logic";
import { Chip, PersonCell, type ChipTone } from "./parts";
import type { ActivityItem, ActivityKind, ActivityResponse } from "./types";

const PAGE_SIZE = 25;

const KINDS = [
  { value: "all", label: "Everything" },
  { value: "visits", label: "Visitors" },
  { value: "outpasses", label: "Outpasses" },
  { value: "gate_form", label: "Gate-form exits" },
];

const OUTCOME_TONE: Record<string, ChipTone> = {
  returned: "green",
  not_returned: "red",
  waiting: "amber",
  outside_now: "amber",
  approved_unused: "slate",
  rejected: "slate",
  early_dismissal: "slate",
};

/** A value that follows `value` only after it has stopped changing for `ms` (so typing does not fire a request per key). */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

const columns: Column<ActivityItem>[] = [
  { key: "at", header: "When", className: "whitespace-nowrap", cell: (i) => stampText(i.at) },
  {
    key: "kind",
    header: "Type",
    cell: (i) =>
      i.kind === "visit" ? (
        <Chip tone="blue">Visitor</Chip>
      ) : i.kind === "outpass" ? (
        <Chip tone="indigo">Outpass</Chip>
      ) : (
        <Chip tone="slate">Gate form</Chip>
      ),
  },
  {
    key: "who",
    header: "Who",
    cell: (i) =>
      i.kind === "visit" ? (
        <PersonCell name={i.visitorName} />
      ) : i.kind === "outpass" ? (
        <PersonCell name={i.name} sub={`${i.code} · ${i.department}`} />
      ) : (
        <PersonCell
          name={i.name ?? "—"}
          sub={
            i.matched ? [i.code, i.department].filter(Boolean).join(" · ") : "Typed on the form, matches no employee"
          }
        />
      ),
  },
  {
    key: "detail",
    header: "Detail",
    cell: (i) =>
      i.kind === "visit" ? (
        <div className="max-w-[18rem]">
          <p className="truncate">
            To meet {i.hostName ?? "—"}
            {i.hostLinked && i.hostDepartment ? ` (${i.hostDepartment})` : ""}
          </p>
          <p className="truncate text-[11px] text-[#006496]/60">{i.purpose ?? "—"}</p>
        </div>
      ) : i.kind === "outpass" ? (
        <div className="max-w-[18rem]">
          <p className="truncate">{i.destination ?? "—"}</p>
          <p className="truncate text-[11px] text-[#006496]/60">{i.passTypeLabel}</p>
        </div>
      ) : (
        <p className="max-w-[18rem] truncate">{i.destination ?? "—"}</p>
      ),
  },
  {
    key: "result",
    header: "Result",
    cell: (i) =>
      i.kind === "outpass" ? (
        <div className="space-y-0.5">
          <Chip tone={OUTCOME_TONE[i.outcome] ?? "slate"}>{i.outcomeLabel}</Chip>
          {i.minutesOut != null && <p className="text-[11px] text-[#006496]/60">{minutesText(i.minutesOut)} out</p>}
        </div>
      ) : i.kind === "gate_form" ? (
        <Chip tone={i.matched ? "green" : "amber"}>{i.matched ? "Matched" : "No match"}</Chip>
      ) : (
        <Chip tone={i.hostLinked ? "green" : "slate"}>{i.hostLinked ? "Host matched" : "Host typed"}</Chip>
      ),
  },
];

/** The newest visits, outpass requests and gate-form exits for drill-down: search by name, place or purpose, filter by
 *  kind, and page through (the server pages; nothing is held in the browser). */
export default function ActivityCard({ params }: { params: Record<string, string> }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const [kind, setKind] = useState<ActivityKind>("all");

  // The page restarts at 1 whenever the filters change: remember which filters the page number was chosen for.
  const filterKey = `${JSON.stringify(params)}|${kind}|${q}`;
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;

  const query = useMdQuery<ActivityResponse>("visitors/activity", {
    ...params,
    page,
    pageSize: PAGE_SIZE,
    q,
    kind: kind === "all" ? undefined : kind,
  });
  const d = query.isError ? undefined : query.data;
  const when = periodPhrase(d?.period);

  return (
    <SectionCard
      title="Recent activity"
      subtitle="Newest first: who came in, who asked to leave, and gate-form exits"
      loading={query.isPending}
      provenance={d?.provenance}
      actions={<AskAiButton question={`What happened at the gate ${when}? Anything unusual in the latest activity?`} />}
      testId="md-visitors-activity"
    >
      {query.isError ? (
        <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 @3xl:flex-row @3xl:items-center @3xl:justify-between">
            <div className="relative w-full @3xl:max-w-sm">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#006496]/50"
              />
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Search a name, department, place or purpose"
                aria-label="Search recent activity"
                className="h-9 pl-8 text-sm"
                data-testid="md-activity-search"
              />
            </div>
            <div className="max-w-full overflow-x-auto pb-1" data-testid="md-activity-kinds">
              <PillTabs size="sm" items={KINDS} value={kind} onChange={(v) => setKind(v as ActivityKind)} />
            </div>
          </div>

          <div className={cn("transition-opacity", query.isFetching && "opacity-60")}>
            <DataTable
              columns={columns}
              rows={d?.items ?? []}
              rowKey={(i) => i.id}
              pageSize={PAGE_SIZE}
              empty={q ? `Nothing matches “${q}”.` : "Nothing was recorded in this period."}
              testId="md-activity-table"
            />
          </div>

          {d && d.total > 0 && (
            <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
              <span data-testid="md-activity-range">{rangeText(d.page, d.pageSize, d.total, d.items.length)}</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPaging({ key: filterKey, page: page - 1 })}
                  data-testid="md-activity-prev"
                >
                  <ChevronLeft size={14} /> Newer
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!d.hasMore}
                  onClick={() => setPaging({ key: filterKey, page: page + 1 })}
                  data-testid="md-activity-next"
                >
                  Older <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
