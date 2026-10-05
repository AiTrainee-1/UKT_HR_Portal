import { useMemo, useState } from "react";
import { Link } from "wouter";
import { LayoutGrid, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { groupReports, searchGroups, sectionsByCategory } from "@/lib/report-catalog";
import type { ReportCatalog } from "@/lib/report-center";
import { reportHref } from "./ReportCatalogView";
import { categoryStyle } from "./report-icons";

/** Left rail inside a report: hop between reports without going back to the catalog. `basePath` is the page that hosts
 *  the Report Center (the MD portal embeds it under /md/reports). */
export function ReportNavRail({
  catalog,
  activeId,
  onNavigate,
  basePath = "/hr/reports",
}: {
  catalog: ReportCatalog;
  activeId: string;
  onNavigate?: () => void;
  basePath?: string;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupReports(catalog.reports), [catalog.reports]);
  const sections = useMemo(
    () => sectionsByCategory(searchGroups(groups, query), catalog.categories),
    [groups, catalog.categories, query],
  );

  return (
    <nav aria-label="Reports" className="space-y-3">
      <Link
        href={basePath}
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-50"
      >
        <LayoutGrid size={14} /> All reports
      </Link>
      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a report…"
          aria-label="Find a report"
          className="h-8 pl-8 text-xs"
        />
      </div>
      {sections.length === 0 && <p className="px-2 text-xs text-muted-foreground">No report matches.</p>}
      {sections.map(({ category, groups: list }) => {
        const s = categoryStyle(category.id);
        return (
          <div key={category.id}>
            <p className="mb-1 flex items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
              {category.label}
            </p>
            <ul>
              {list.map((g) => {
                const active = g.variants.some((v) => v.id === activeId);
                return (
                  <li key={g.key}>
                    <Link
                      href={reportHref(active ? activeId : g.primary.id, basePath)}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`block truncate rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
                        active
                          ? "bg-sky-50 font-semibold text-sky-800"
                          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                      }`}
                    >
                      {g.primary.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
