import { useEffect, useState } from "react";
import { ChevronDown, Search, ShieldCheck, X } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { Input } from "@/components/ui/input";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import type { PeriodChoice } from "@/lib/md/period";
import { cn } from "@/lib/utils";
import FeedRow from "./FeedRow";
import RuleTable from "./RuleTable";
import { MAX_PAGE_SIZE, PAGE_STEP, ask, canShowMore, feedParams, nextPageSize } from "./logic";
import { FilterChip } from "./parts";
import type { ActivityFeed, ActivitySensitive, CategoryId } from "./types";

type Mode = "sensitive" | "all";

const MODES: { id: Mode; label: string }[] = [
  { id: "sensitive", label: "Sensitive" },
  { id: "all", label: "All activity" },
];

/** The sensitive actions, newest first, with the category filters, a search, and a switch to the whole activity feed.
 *  "Show more" asks the server for ten more at a time (a bulk upload is one line, so lists stay short). */
export default function SensitiveCard({
  period,
  label,
  user,
  onUserChange,
}: {
  period: PeriodChoice;
  label: string;
  /** A person picked in the people table: only their actions are listed. */
  user: string | null;
  onUserChange: (name: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("sensitive");
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);

  // the search is sent a moment after typing stops
  useEffect(() => {
    const id = setTimeout(() => setQ(text), 250);
    return () => clearTimeout(id);
  }, [text]);

  // how many lines are shown resets whenever the question changes
  const questionKey = JSON.stringify([period, mode, mode === "sensitive" ? category : null, q, user]);
  const [size, setSize] = useState({ key: questionKey, n: PAGE_STEP });
  const pageSize = size.key === questionKey ? size.n : PAGE_STEP;

  const params = feedParams(period, { pageSize, q, category: mode === "sensitive" ? category : null, user });
  const sensitive = useMdQuery<ActivitySensitive>("activity/sensitive", params, { enabled: mode === "sensitive" });
  const feed = useMdQuery<ActivityFeed>("activity/feed", params, { enabled: mode === "all" });
  const query = mode === "sensitive" ? sensitive : feed;
  const data = query.data;
  const chips = sensitive.data?.categories.filter((c) => c.count > 0 || c.id === category) ?? [];
  const filtered = Boolean(q.trim() || user || (mode === "sensitive" && category));
  const coverage = sensitive.data?.provenance.find((p) => p.id === "sensitive")?.caveats[0];

  return (
    <SectionCard
      title={mode === "sensitive" ? "Sensitive actions" : "All activity"}
      subtitle={
        mode === "sensitive"
          ? "Access changes, deletions, payroll runs, bulk uploads, exports, settings and backups, newest first"
          : "Everything people did in the HR portal, newest first. Sign-ins are on the card below"
      }
      provenance={data?.provenance}
      loading={query.isPending}
      actions={
        <>
          <div className="md-seg" role="group" aria-label="What to list">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={mode === m.id}
                onClick={() => setMode(m.id)}
                data-testid={`md-activity-mode-${m.id}`}
                className="md-seg-item min-h-9 whitespace-nowrap"
              >
                {m.label}
              </button>
            ))}
          </div>
          <AskAiButton question={ask.sensitive(label, category ? chips.find((c) => c.id === category)?.label : null)} />
        </>
      }
      testId="md-activity-sensitive"
    >
      <div className="space-y-3">
        {mode === "sensitive" && chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="md-activity-categories">
            <FilterChip
              active={category === null}
              onClick={() => setCategory(null)}
              count={sumOf(chips)}
              testId="md-activity-category-all"
            >
              All
            </FilterChip>
            {chips.map((c) => (
              <FilterChip
                key={c.id}
                active={category === c.id}
                onClick={() => setCategory(category === c.id ? null : c.id)}
                count={c.count}
                testId={`md-activity-category-${c.id}`}
              >
                {c.label}
              </FilterChip>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-md-ink-soft"
              aria-hidden="true"
            />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search a person, a word or an area"
              aria-label="Search the activity"
              data-testid="md-activity-search"
              className="h-10 pl-9 text-sm"
            />
          </div>
          {user && (
            <button
              type="button"
              onClick={() => onUserChange(null)}
              data-testid="md-activity-user-filter"
              className="md-people-pill is-on"
            >
              Only {user}
              <X size={12} aria-label="Show everyone" />
            </button>
          )}
        </div>

        {query.isError ? (
          <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
        ) : data && data.items.length === 0 ? (
          <EmptyBlock
            icon={ShieldCheck}
            title={
              filtered
                ? "Nothing matches"
                : mode === "sensitive"
                  ? "Nothing sensitive in this period"
                  : "No activity in this period"
            }
            testId="md-activity-feed-empty"
          >
            {filtered
              ? "Try another category, search or person."
              : mode === "sensitive"
                ? "No account changes, deletions, payroll runs, bulk uploads, exports or settings changes were recorded."
                : "Nothing was done in the HR portal in this period."}
          </EmptyBlock>
        ) : data ? (
          <>
            <ul data-testid="md-activity-feed">
              {data.items.map((item) => (
                <FeedRow key={item.id} item={item} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-md-line pt-3 text-xs font-medium text-md-ink-soft">
              <span data-testid="md-activity-feed-count">
                Showing {num(data.items.length)} of {num(data.total)}
                {data.pageSize >= MAX_PAGE_SIZE && data.total > data.items.length
                  ? ". Narrow the period or search to see the rest"
                  : ""}
              </span>
              {canShowMore(data.total, data.items.length, pageSize) && (
                <button
                  type="button"
                  onClick={() => setSize({ key: questionKey, n: nextPageSize(pageSize) })}
                  data-testid="md-activity-show-more"
                  className="md-btn md-btn-soft md-btn-sm min-h-9"
                >
                  Show more
                </button>
              )}
            </div>
          </>
        ) : null}

        {mode === "sensitive" && sensitive.data?.rules && (
          <div className="border-t border-md-line pt-4">
            <button
              type="button"
              onClick={() => setRulesOpen((v) => !v)}
              aria-expanded={rulesOpen}
              data-testid="md-activity-rules-toggle"
              className="md-btn md-btn-soft md-btn-sm min-h-9"
            >
              What counts as sensitive?
              <ChevronDown
                size={14}
                className={cn("transition-transform motion-reduce:transition-none", rulesOpen && "rotate-180")}
              />
            </button>
            {rulesOpen && (
              <div className="mt-3">
                <RuleTable rules={sensitive.data.rules} />
              </div>
            )}
          </div>
        )}
        {coverage && (
          <p className="text-[11px] leading-snug text-md-ink-soft" data-testid="md-activity-coverage">
            {coverage}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

const sumOf = (chips: { count: number }[]) => chips.reduce((n, c) => n + c.count, 0);
