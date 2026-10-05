import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Clock, Search, Star, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { groupReports, searchGroups, sectionsByCategory, type ReportGroup } from "@/lib/report-catalog";
import type { ReportCatalog } from "@/lib/report-center";
import { toggleFavorite, useReportPrefs } from "@/lib/report-prefs";
import { categoryStyle, iconFor } from "./report-icons";

/** Where a report opens. `basePath` is the page hosting the Report Center (the MD portal embeds it at /md/reports). */
export const reportHref = (id: string, basePath = "/hr/reports") => `${basePath}?report=${encodeURIComponent(id)}`;

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
        <span className="mt-3 flex items-center gap-2 text-[11px] font-semibold text-gray-400">
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

/** The landing view: search + starred + recent + every report grouped by category. */
export function ReportCatalogView({ catalog }: { catalog: ReportCatalog }) {
  const [query, setQuery] = useState("");
  const { favorites, recents } = useReportPrefs();
  const groups = useMemo(() => groupReports(catalog.reports), [catalog.reports]);
  const found = useMemo(() => searchGroups(groups, query), [groups, query]);
  const starredIds = useMemo(() => new Set(favorites), [favorites]);
  const searching = query.trim().length > 0;

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
  const sections = sectionsByCategory(found, catalog.categories);
  const total = groups.length;

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
          placeholder="Search reports - try “PF”, “overtime”, “late”, “visitor”…"
          aria-label="Search reports"
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

      {!searching && (
        <div className="flex flex-wrap gap-2">
          {catalog.categories.map((c) => {
            const s = categoryStyle(c.id);
            return (
              <a
                key={c.id}
                href={`#cat-${c.id}`}
                className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-xs font-semibold text-gray-700 shadow-sm hover:border-gray-300"
              >
                <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                {c.label}
                <span className="text-gray-400">{c.count}</span>
              </a>
            );
          })}
        </div>
      )}

      {!searching && (
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
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {found.length === 0 ? "No report matches" : `${found.length} of ${total} reports match`} “{query.trim()}”.
        </p>
      )}

      {sections.map(({ category, groups: list }) => {
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
