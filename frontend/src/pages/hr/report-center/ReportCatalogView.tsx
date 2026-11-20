import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowUpRight, Clock, Search, SearchX, Star, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useSavedCustomReports } from "@/lib/api-client/custom-hooks/report-customise";
import { groupReports, searchGroups, type ReportGroup } from "@/lib/report-catalog";
import type { ReportCatalog } from "@/lib/report-center";
import { toggleFavorite, useReportPrefs } from "@/lib/report-prefs";
import { useLevel } from "@/lib/tab-access";
import { CustomiseSection } from "./customise/CustomiseSection";
import { searchSaved } from "./customise/builder-logic";
import { categoryStyle, iconFor } from "./report-icons";

/** Where a report opens. `basePath` is the page hosting the Report Center (the MD portal embeds it at /md/reports). */
export const reportHref = (id: string, basePath = "/hr/reports") => `${basePath}?report=${encodeURIComponent(id)}`;

/** The category whose tiles are the saved custom reports (Report Center -> Customise). */
export const CUSTOMISE_CATEGORY = "customise";

function StarButton({ id, on }: { id: string; on: boolean }) {
  return (
    <button
      type="button"
      aria-label={on ? "Unstar this report" : "Star this report"}
      aria-pressed={on}
      onClick={() => toggleFavorite(id)}
      className={`absolute right-2.5 top-2.5 rounded-md p-1 transition-colors ${
        on ? "text-amber-500" : "text-gray-300 hover:bg-gray-100 hover:text-gray-500"
      }`}
    >
      <Star size={15} className={on ? "fill-amber-400" : ""} />
    </button>
  );
}

function ReportTile({ group, starred }: { group: ReportGroup; starred: boolean }) {
  const r = group.primary;
  const Icon = iconFor(r.icon);
  const style = categoryStyle(r.category);
  const views = group.variants.length;
  return (
    <div className="group relative">
      <Link
        href={reportHref(r.id)}
        className="flex h-full flex-col rounded-xl border bg-white p-4 pr-9 shadow-sm transition-all hover:-translate-y-0.5 hover:border-sky-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <span
          className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${style.chip} ${style.ring}`}
        >
          <Icon size={18} />
        </span>
        <span className="text-sm font-bold text-gray-900">{r.title}</span>
        <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{r.description}</span>
        <span className="mt-3 flex items-center gap-2 text-[11px] font-semibold text-gray-500">
          {views > 1 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
              {views} views: {group.variants.map((v) => v.variant).join(" · ")}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-0.5 text-sky-700 opacity-0 transition-opacity group-hover:opacity-100">
            Open <ArrowUpRight size={12} />
          </span>
        </span>
      </Link>
      <StarButton id={r.id} on={starred} />
    </div>
  );
}

function Strip({
  title,
  icon,
  groups,
  starredIds,
}: {
  title: string;
  icon: ReactNode;
  groups: ReportGroup[];
  starredIds: Set<string>;
}) {
  if (!groups.length) return null;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
        {icon} {title}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => (
          <ReportTile key={g.key} group={g} starred={g.variants.some((v) => starredIds.has(v.id))} />
        ))}
      </div>
    </section>
  );
}

/**
 * A category chip: narrows the catalog to that category (again: back to all). It stays a link to the section's anchor
 * (#cat-<id>), so the Clean theme dresses it like before and a middle click still jumps there; a plain click or
 * Space / Enter toggles the filter instead.
 */
function CategoryChip({
  id,
  active,
  onPick,
  dot,
  count,
  children,
}: {
  id: string;
  active: boolean;
  onPick: () => void;
  dot?: string;
  count: number;
  children: ReactNode;
}) {
  const pick = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    onPick();
  };
  return (
    <a
      href={`#cat-${id}`}
      role="button"
      aria-pressed={active}
      data-testid={`report-chip-${id}`}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        pick(e);
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") pick(e);
      }}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        active
          ? "border-sky-300 bg-sky-50 text-sky-800 ring-1 ring-sky-200"
          : "bg-white text-gray-700 hover:border-gray-300"
      }`}
    >
      {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
      {children}
      <span className={active ? "text-sky-700" : "text-gray-500"}>{count}</span>
    </a>
  );
}

/**
 * The landing view: search + category chips (each narrows to one category; "All" shows everything) + starred + recent +
 * every report grouped by category, the Customise section with the saved custom reports among them. The search and the
 * chosen category live in the address (?q= and ?cat=), so Back from an opened report restores them.
 */
export function ReportCatalogView({ catalog }: { catalog: ReportCatalog }) {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const urlQuery = params.get("q") ?? "";
  const urlCat = params.get("cat");
  const catId = urlCat && catalog.categories.some((c) => c.id === urlCat) ? urlCat : null;

  // The box keeps exactly what is typed; the address follows it (and Back / forward bring a search back into the box).
  const [query, setQueryText] = useState(urlQuery);
  const lastWritten = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery === lastWritten.current) return;
    lastWritten.current = urlQuery;
    setQueryText(urlQuery);
  }, [urlQuery]);

  const writeUrl = (q: string, cat: string | null) => {
    const next = new URLSearchParams(params);
    const kept = q.trim() ? q : "";
    if (kept) next.set("q", kept);
    else next.delete("q");
    if (cat) next.set("cat", cat);
    else next.delete("cat");
    lastWritten.current = kept;
    const qs = next.toString();
    navigate(qs ? `${location}?${qs}` : location, { replace: true });
  };
  const setQuery = (q: string) => {
    setQueryText(q);
    writeUrl(q, catId);
  };
  const pickCategory = (id: string | null) => writeUrl(query, id);

  const { favorites, recents } = useReportPrefs();
  const level = useLevel();
  const groups = useMemo(() => groupReports(catalog.reports), [catalog.reports]);
  const scoped = useMemo(() => (catId ? groups.filter((g) => g.category === catId) : groups), [groups, catId]);
  const found = useMemo(() => searchGroups(scoped, query), [scoped, query]);
  const starredIds = useMemo(() => new Set(favorites), [favorites]);
  const searching = query.trim().length > 0;

  // Customise: the saved reports' details (who changed them, data source ...) come from the builder's own list.
  const customise = catalog.categories.find((c) => c.id === CUSTOMISE_CATEGORY);
  // The saved list holds exactly the reports the catalog lists for this role (the server leaves out those on a data
  // source the role cannot use), so the tiles, the chip's count and the search count agree; a copy made here shows at
  // once, before the catalog is fetched again.
  const saved = useSavedCustomReports({ enabled: !!customise });
  const savedFound = useMemo(() => (saved.data ? searchSaved(saved.data, query) : undefined), [saved.data, query]);
  const canCreate = level(`reports.${CUSTOMISE_CATEGORY}`) === "edit";
  const customiseFallback = useMemo(() => found.filter((g) => g.category === CUSTOMISE_CATEGORY), [found]);
  const customiseInScope = !!customise && (!catId || catId === CUSTOMISE_CATEGORY);
  const matchCount =
    found.filter((g) => g.category !== CUSTOMISE_CATEGORY).length +
    (customiseInScope ? (savedFound ? savedFound.length : customiseFallback.length) : 0);

  const byId = useMemo(() => {
    const m = new Map<string, ReportGroup>();
    groups.forEach((g) => g.variants.forEach((v) => m.set(v.id, g)));
    return m;
  }, [groups]);
  const pick = (ids: string[]) => {
    const seen = new Set<string>();
    const out: ReportGroup[] = [];
    for (const id of ids) {
      const g = byId.get(id);
      if (g && !seen.has(g.key)) {
        seen.add(g.key);
        out.push(g);
      }
    }
    return out;
  };
  const categoryLabel = catalog.categories.find((c) => c.id === catId)?.label;
  const shownCategories = catalog.categories.filter((c) => !catId || c.id === catId);

  return (
    <div className="space-y-6">
      <div className="relative max-w-2xl">
        <Search
          size={16}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reports - try “PF”, “overtime”, “late”, “shift”…"
          aria-label="Search reports"
          data-testid="report-search"
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

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category" data-testid="report-chips">
        <CategoryChip id="all" active={catId === null} onPick={() => pickCategory(null)} count={groups.length}>
          All reports
        </CategoryChip>
        {catalog.categories.map((c) => (
          <CategoryChip
            key={c.id}
            id={c.id}
            active={catId === c.id}
            onPick={() => pickCategory(catId === c.id ? null : c.id)}
            dot={categoryStyle(c.id).dot}
            count={c.count}
          >
            {c.label}
          </CategoryChip>
        ))}
      </div>

      {!searching && !catId && (
        <>
          <Strip
            title="Starred"
            icon={<Star size={12} className="fill-amber-400 text-amber-500" />}
            groups={pick(favorites)}
            starredIds={starredIds}
          />
          <Strip
            title="Recently opened"
            icon={<Clock size={12} />}
            groups={pick(recents).slice(0, 3)}
            starredIds={starredIds}
          />
        </>
      )}

      {searching && (
        <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="report-match-count">
          {matchCount === 0
            ? "No report matches"
            : `${matchCount} of ${scoped.length} report${scoped.length === 1 ? "" : "s"} match`}{" "}
          “{query.trim()}”{categoryLabel ? ` in ${categoryLabel}` : ""}.
        </p>
      )}

      {searching && matchCount === 0 && (
        <div className="rounded-xl border bg-white px-6 py-12 text-center" data-testid="report-no-match">
          <SearchX className="mx-auto mb-3 h-9 w-9 text-gray-300" />
          <p className="text-base font-semibold text-gray-700">Nothing found for “{query.trim()}”</p>
          <p className="mt-1 text-sm text-muted-foreground">Try a shorter word, such as “late”, “salary” or “shift”.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-3 text-sm font-semibold">
            <button type="button" className="text-sky-700 hover:underline" onClick={() => setQuery("")}>
              Clear the search
            </button>
            {catId && (
              <button type="button" className="text-sky-700 hover:underline" onClick={() => pickCategory(null)}>
                Search every category
              </button>
            )}
          </div>
        </div>
      )}

      {shownCategories.map((category) => {
        if (category.id === CUSTOMISE_CATEGORY) {
          return (
            <CustomiseSection
              key={category.id}
              category={category}
              items={savedFound}
              loading={saved.isLoading}
              failed={saved.isError}
              fallback={customiseFallback}
              searching={searching}
              canCreate={canCreate}
              hrefFor={(id) => reportHref(id)}
            />
          );
        }
        const list = found.filter((g) => g.category === category.id);
        if (!list.length) return null;
        const s = categoryStyle(category.id);
        const Icon = iconFor(category.icon);
        return (
          <section key={category.id} id={`cat-${category.id}`} className="scroll-mt-4">
            <div className="mb-3 flex items-center gap-3">
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ring-1 ${s.chip} ${s.ring}`}>
                <Icon size={16} />
              </span>
              <div>
                <h3 className="text-base font-black text-gray-900">{category.label}</h3>
                <p className="text-xs text-muted-foreground">{category.description}</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((g) => (
                <ReportTile key={g.key} group={g} starred={g.variants.some((v) => starredIds.has(v.id))} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
