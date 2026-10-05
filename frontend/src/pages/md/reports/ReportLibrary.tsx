import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Search, SearchX, Sparkles, X } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { EmptyBlock } from "@/components/md/kit/states";
import { Input } from "@/components/ui/input";
import { useReportPrefs } from "@/lib/report-prefs";
import { cn } from "@/lib/utils";
import { categoryStyle, iconFor } from "@/pages/hr/report-center/report-icons";
import { LibraryCard } from "./ReportCards";
import { ASK_EXAMPLES, PREVIEW_PER_CATEGORY, categoryLabel, libraryView, type Library } from "./report-library";

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
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold shadow-sm transition-colors",
        active
          ? "border-[#006496] bg-[#006496] text-white"
          : "border-[#006496]/15 bg-white text-gray-700 hover:border-[#006496]/35",
      )}
    >
      {dot && <span className={cn("h-2 w-2 rounded-full", dot)} />}
      {children}
      <span className={active ? "text-white/70" : "text-gray-400"}>{count}</span>
    </button>
  );
}

const GRID = "grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3";

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
      className="scroll-mt-4 space-y-4"
      data-testid="md-report-library"
    >
      <div>
        <h3 id="md-library-heading" className="text-base font-black text-[#1a3a4a]">
          Report library
        </h3>
        <p className="text-xs text-[#006496]/60">
          {library.standard.length} reports in {library.categories.length} categories. Open one to choose its filters,
          then view, print or export it.
        </p>
      </div>

      <div className="relative max-w-2xl">
        <Search
          size={16}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search every report - try “overtime”, “late”, “salary”, “visitor”…"
          aria-label="Search reports"
          data-testid="md-report-search"
          className="h-11 rounded-xl bg-white pl-10 pr-10 text-sm shadow-sm"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-gray-100"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2" data-testid="md-report-chips">
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
            dot={categoryStyle(category.id).dot}
            count={count}
            testId={`md-chip-${category.id}`}
          >
            {category.label}
          </Chip>
        ))}
      </div>

      <div
        className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e0a83a]/30 bg-[#fffaf0] px-3 py-2.5"
        data-testid="md-reports-ask-ai"
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8a5d00]">
          <Sparkles size={13} className="text-[#e0a83a]" /> Not sure which report you need?
        </span>
        {ASK_EXAMPLES.map((question) => (
          <AskAiButton key={question} question={question} label={question} />
        ))}
      </div>

      {view.mode === "results" && (
        <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="md-report-count">
          {view.total === 0 ? "No report matches" : `${view.total} of ${library.all.length} reports match`} “{text}”.
        </p>
      )}

      {view.mode === "results" ? (
        view.groups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#006496]/20 bg-white/70">
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
        <div className="rounded-2xl bg-white/70">
          <EmptyBlock title="No reports to show yet" testId="md-report-library-empty">
            The library is empty. Reports appear here as soon as the Report Center has any.
          </EmptyBlock>
        </div>
      ) : (
        <div className="space-y-7">
          {view.sections.map(({ category, groups }) => {
            const style = categoryStyle(category.id);
            const Icon = iconFor(category.icon);
            // With a category chosen the page is already that one category: show all of it, no "Show all" needed.
            const collapsible = categoryId === null && groups.length > PREVIEW_PER_CATEGORY;
            const showAll = !collapsible || expanded.has(category.id);
            const shown = showAll ? groups : groups.slice(0, PREVIEW_PER_CATEGORY);
            return (
              <div key={category.id} data-testid={`md-category-${category.id}`}>
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className={cn(
                      "inline-flex h-8 w-8 items-center justify-center rounded-lg ring-1",
                      style.chip,
                      style.ring,
                    )}
                  >
                    <Icon size={16} />
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-black text-[#1a3a4a]">
                      {category.label} <span className="font-semibold text-gray-400">{groups.length}</span>
                    </h4>
                    <p className="text-xs text-muted-foreground">{category.description}</p>
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
                    className="mt-3 inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-[#006496] hover:bg-[#006496]/[0.06]"
                  >
                    {showAll ? (
                      <>
                        Show fewer <ChevronUp size={13} />
                      </>
                    ) : (
                      <>
                        Show all {groups.length} <ChevronDown size={13} />
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
