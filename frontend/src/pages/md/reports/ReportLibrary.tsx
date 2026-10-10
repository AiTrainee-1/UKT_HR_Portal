import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Search, SearchX, Sparkles, X } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { EmptyBlock } from "@/components/md/kit/states";
import { Input } from "@/components/ui/input";
import { useReportPrefs } from "@/lib/report-prefs";
import { cn } from "@/lib/utils";
import { iconFor } from "@/pages/hr/report-center/report-icons";
import { categoryTone } from "./category-tone";
import { LibraryCard } from "./ReportCards";
import { ASK_EXAMPLES, PREVIEW_PER_CATEGORY, categoryLabel, libraryView, type Library } from "./report-library";

/** A category filter: a pill, the chosen one wine glass (md-theme/areas/money.css). */
function Chip({
  active,
  onClick,
  dot,
  count,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dot?: string;
  count: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} data-testid={testId} className="md-money-chip">
      {dot && <span className={cn("h-2 w-2 rounded-full ring-2 ring-white/60", dot)} />}
      {children}
      <span className="md-money-chip-count">{count}</span>
    </button>
  );
}

const GRID = "grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3";

/**
 * Every report the MD can open: search across title, description and category, category chips, and the cards grouped by
 * category (each showing its first few, with "Show all"). The MD's own executive reports are on the shelf above, so
 * browsing leaves them out; a search, or choosing a category, looks at everything.
 */
export function ReportLibrary({ library }: { library: Library }) {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { favorites } = useReportPrefs();
  const view = useMemo(() => libraryView(library, query, categoryId), [library, query, categoryId]);
  const text = query.trim();

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section
      id="md-report-library"
      aria-labelledby="md-library-heading"
      className="scroll-mt-4 space-y-5"
      data-testid="md-report-library"
    >
      <div>
        <h3 id="md-library-heading" className="text-lg font-black leading-tight tracking-tight text-md-ink">
          Report library
        </h3>
        <p className="mt-0.5 text-[13px] text-md-ink-soft">
          {library.standard.length} reports in {library.categories.length} categories. Open one to choose its filters,
          then view, print or export it.
        </p>
      </div>

      <div className="relative max-w-2xl">
        <Search
          size={17}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-md-ink-soft"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search every report - try “overtime”, “late”, “salary”, “visitor”…"
          aria-label="Search reports"
          data-testid="md-report-search"
          className="md-money-search h-12 pl-11 pr-11 text-sm"
        />
        {query && (
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="md-btn md-btn-ghost md-btn-icon"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        )}
      </div>

      <div
        role="group"
        aria-label="Filter by category"
        className="flex flex-wrap gap-2.5"
        data-testid="md-report-chips"
      >
        <Chip
          active={categoryId === null}
          onClick={() => setCategoryId(null)}
          count={library.standard.length}
          testId="md-chip-all"
        >
          All reports
        </Chip>
        {library.categories.map(({ category, count }) => (
          <Chip
            key={category.id}
            active={categoryId === category.id}
            onClick={() => setCategoryId(categoryId === category.id ? null : category.id)}
            dot={categoryTone(category.id).dot}
            count={count}
            testId={`md-chip-${category.id}`}
          >
            {category.label}
          </Chip>
        ))}
      </div>

      <div className="md-panel-sand flex flex-wrap items-center gap-2 px-4 py-3" data-testid="md-reports-ask-ai">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-md-warning-800">
          <Sparkles size={14} className="text-md-warning-500" aria-hidden /> Not sure which report you need?
        </span>
        {ASK_EXAMPLES.map((question) => (
          <AskAiButton key={question} question={question} label={question} />
        ))}
      </div>

      {view.mode === "results" && (
        <p className="text-sm font-medium text-md-ink-soft" aria-live="polite" data-testid="md-report-count">
          {view.total === 0 ? "No report matches" : `${view.total} of ${library.all.length} reports match`} “{text}”.
        </p>
      )}

      {view.mode === "results" ? (
        view.groups.length === 0 ? (
          <div className="md-panel">
            <EmptyBlock icon={SearchX} title={`No report matches “${text}”`} testId="md-report-no-match">
              Try a shorter word, such as “late”, “salary” or “visitor”, or ask the assistant which report to use.
            </EmptyBlock>
          </div>
        ) : (
          <div className={GRID}>
            {view.groups.map((g) => (
              <LibraryCard
                key={g.key}
                group={g}
                favorites={favorites}
                category={categoryLabel(library.allCategories, g.category)}
              />
            ))}
          </div>
        )
      ) : view.total === 0 ? (
        <div className="md-panel">
          <EmptyBlock title="No reports to show yet" testId="md-report-library-empty">
            The library is empty. Reports appear here as soon as the Report Center has any.
          </EmptyBlock>
        </div>
      ) : (
        <div className="space-y-9">
          {view.sections.map(({ category, groups }) => {
            const tone = categoryTone(category.id);
            const Icon = iconFor(category.icon);
            // With a category chosen the page is already that one category: show all of it, no "Show all" needed.
            const collapsible = categoryId === null && groups.length > PREVIEW_PER_CATEGORY;
            const showAll = !collapsible || expanded.has(category.id);
            const shown = showAll ? groups : groups.slice(0, PREVIEW_PER_CATEGORY);
            return (
              <div key={category.id} data-testid={`md-category-${category.id}`}>
                <div className="mb-4 flex items-center gap-3">
                  <span className={cn("md-money-tile md-money-tile-sm", tone.tone)}>
                    <Icon size={16} aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-[15px] font-black leading-tight text-md-ink">
                      {category.label}{" "}
                      <span className="ml-1 text-[13px] font-bold tabular-nums text-md-ink-soft">{groups.length}</span>
                    </h4>
                    <p className="mt-0.5 text-[12.5px] text-md-ink-soft">{category.description}</p>
                  </div>
                </div>
                <div className={GRID}>
                  {shown.map((g) => (
                    <LibraryCard key={g.key} group={g} favorites={favorites} />
                  ))}
                </div>
                {collapsible && (
                  <button
                    type="button"
                    aria-expanded={showAll}
                    data-testid={`md-more-${category.id}`}
                    onClick={() => toggleExpanded(category.id)}
                    className="md-btn md-btn-soft md-btn-sm mt-4"
                  >
                    {showAll ? (
                      <>
                        Show fewer <ChevronUp size={14} aria-hidden />
                      </>
                    ) : (
                      <>
                        Show all {groups.length} <ChevronDown size={14} aria-hidden />
                      </>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
