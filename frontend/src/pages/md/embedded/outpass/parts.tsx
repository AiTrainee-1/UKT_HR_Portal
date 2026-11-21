import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import { sortInsights, toInsight } from "@/components/md/kit/dto";
import { EmptyBlock, ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import type { MdInsightDto, Provenance } from "@/lib/md/types";
import BriefingList from "../shared/BriefingList";
import type { Sentence } from "./types";

// The pieces the Gate Pass, Visitors and Tea Break Insights share: the error and refreshing states of a card, the "In plain
// words" card, "Needs your attention", the tile grid and the pager of a drill-down list.

/** A card whose request failed: what the server said, and a retry. The other cards are unaffected. */
export function QueryError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** While a changed filter loads, the old figures stay on screen; this dims them so nobody reads them as the new ones. */
export function refreshingClass(...queries: UseQueryResult<unknown>[]): string {
  return queries.some((q) => q.isFetching && !q.isPending) ? "opacity-60 transition-opacity" : "transition-opacity";
}

/** The page in a few plain sentences, written by the server from the very figures below (no AI until Explain). */
export function BriefCard({
  query,
  ask,
  testId,
  empty,
}: {
  query: UseQueryResult<{ sentences: Sentence[]; ask?: string; provenance: Provenance[] }>;
  ask: string;
  testId: string;
  empty: string;
}) {
  const data = query.data;
  return (
    <SectionCard
      title="In plain words"
      subtitle="Written from the figures below by fixed rules: no AI is asked until you press Explain"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={data?.ask || ask} label="Explain with AI" />}
      bodyClassName={refreshingClass(query)}
      testId={testId}
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && data.sentences.length > 0 ? (
        <BriefingList sentences={data.sentences} testIdPrefix={`${testId}-sentence`} />
      ) : data ? (
        <EmptyBlock title="Nothing to say yet">{empty}</EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

/** "Needs your attention": the exceptions of this period, worst first, each with Explain (links point here: left out). */
export function AttentionCard({
  items,
  query,
  ask,
  testId,
}: {
  items: MdInsightDto[];
  query: UseQueryResult<unknown>;
  ask: string;
  testId: string;
}) {
  const list = sortInsights(items).map((dto) => toInsight({ ...dto, page: null }));
  return (
    <SectionCard
      title="Needs your attention"
      subtitle="What stands out in this period, worst first"
      loading={query.isPending}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId={testId}
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <InsightList items={list} emptyText="Nothing needs your attention in this period." />
      )}
    </SectionCard>
  );
}

/** The tiles: two a row on a phone (an odd last one spans both), four from a medium container. */
export function TileGrid({ children, className, testId }: { children: ReactNode; className?: string; testId: string }) {
  return (
    <div
      className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 [&>*:last-child:nth-child(odd)]:col-span-2 @3xl:[&>*:last-child:nth-child(odd)]:col-span-1 ${className ?? ""}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** The envelope's notes, once, under the cards. */
export function Notes({ notes, testId }: { notes: string[] | undefined; testId: string }) {
  if (!notes || notes.length === 0) return null;
  return (
    <NoteBanner>
      <div data-testid={testId}>
        <p className="font-semibold">About these figures</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </NoteBanner>
  );
}

/** Previous / next page of a drill-down list, with where in the list the MD is. */
export function Pager({
  page,
  pageSize,
  total,
  hasMore,
  onPage,
  testId,
}: {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  onPage: (page: number) => void;
  testId: string;
}) {
  if (total <= pageSize) {
    return (
      <p className="md-analytics-note px-1" data-testid={testId}>
        {num(total)} {total === 1 ? "record" : "records"}
      </p>
    );
  }
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const button = "md-btn inline-flex h-9 w-9 items-center justify-center rounded-lg disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-2 px-1" data-testid={testId}>
      <span className="text-xs font-semibold text-md-ink-soft">
        {num(first)} to {num(last)} of {num(total)}
      </span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          className={button}
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          data-testid={`${testId}-prev`}
        >
          <ChevronLeft size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={button}
          onClick={() => onPage(page + 1)}
          disabled={!hasMore}
          aria-label="Next page"
          data-testid={`${testId}-next`}
        >
          <ChevronRight size={15} aria-hidden />
        </button>
      </span>
    </div>
  );
}
