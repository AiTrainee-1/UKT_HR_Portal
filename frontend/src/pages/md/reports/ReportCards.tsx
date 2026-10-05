import { Link } from "wouter";
import { ArrowRight, ArrowUpRight, Star } from "lucide-react";
import { MD_GOLD_GRADIENT } from "@/components/md/MdSidebar";
import type { ReportGroup } from "@/lib/report-catalog";
import type { ReportMeta } from "@/lib/report-center";
import { toggleFavorite } from "@/lib/report-prefs";
import { cn } from "@/lib/utils";
import { reportHref } from "@/pages/hr/report-center/ReportCatalogView";
import { categoryStyle, iconFor } from "@/pages/hr/report-center/report-icons";
import { MD_REPORTS_PATH, starredIdOf } from "./report-library";

const hrefFor = (id: string) => reportHref(id, MD_REPORTS_PATH);

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006496]/40";

/** One of the MD's own reports: the shelf at the top of the page. A large card with the portal's gold, a plain-English
 *  description and where it leads. */
export function ExecutiveCard({ group }: { group: ReportGroup }) {
  const report = group.primary;
  const Icon = iconFor(report.icon);
  const views = group.variants.length;
  return (
    <Link
      href={hrefFor(report.id)}
      data-testid={`executive-card-${report.id}`}
      className={cn("clay-card group relative flex h-full flex-col overflow-hidden rounded-2xl p-5 pt-6", FOCUS)}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: MD_GOLD_GRADIENT }} />
      <span
        className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl text-[#5b3d00] shadow-sm"
        style={{ background: MD_GOLD_GRADIENT }}
      >
        <Icon size={22} />
      </span>
      <span className="text-[15px] font-black leading-snug text-[#1a3a4a]">{report.title}</span>
      <span className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{report.description}</span>
      <span className="mt-auto flex items-center gap-2 pt-4">
        {views > 1 && (
          <span className="rounded-full bg-[#fbf3dc] px-2 py-0.5 text-[11px] font-semibold text-[#8a5d00]">
            {views} views
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-bold text-[#006496]">
          Open report <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </span>
    </Link>
  );
}

/** A report's star: starred reports are kept under "Starred" at the top of the page. */
function StarButton({ group, favorites }: { group: ReportGroup; favorites: string[] }) {
  const starred = starredIdOf(group, favorites);
  return (
    <button
      type="button"
      aria-label={starred ? "Unstar this report" : "Star this report"}
      aria-pressed={!!starred}
      onClick={() => toggleFavorite(starred ?? group.primary.id)}
      className={cn(
        "absolute right-2.5 top-2.5 rounded-md p-1 transition-colors",
        starred ? "text-amber-500" : "text-gray-300 hover:bg-gray-100 hover:text-gray-500",
      )}
    >
      <Star size={15} className={starred ? "fill-amber-400" : ""} />
    </button>
  );
}

/** A report in the library. `category` (the category's name) is shown when the card is not already under its heading. */
export function LibraryCard({
  group,
  favorites,
  category,
}: {
  group: ReportGroup;
  favorites: string[];
  category?: string;
}) {
  const report = group.primary;
  const Icon = iconFor(report.icon);
  const style = categoryStyle(report.category);
  const views = group.variants.length;
  return (
    <div className="group relative" data-testid={`report-card-${report.id}`}>
      <Link
        href={hrefFor(report.id)}
        className={cn(
          "flex h-full flex-col rounded-2xl border border-[#006496]/10 bg-white p-4 pr-10 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#006496]/30 hover:shadow-md",
          FOCUS,
        )}
      >
        <span
          className={cn(
            "mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl ring-1",
            style.chip,
            style.ring,
          )}
        >
          <Icon size={18} />
        </span>
        <span className="text-sm font-bold text-[#1a3a4a]">{report.title}</span>
        <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{report.description}</span>
        <span className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold">
          {category && (
            <span className="inline-flex items-center gap-1 text-gray-500">
              <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
              {category}
            </span>
          )}
          {views > 1 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
              {views} views: {group.variants.map((v) => v.variant).join(" · ")}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-0.5 text-[#006496]/80 group-hover:text-[#006496]">
            Open <ArrowUpRight size={12} />
          </span>
        </span>
      </Link>
      <StarButton group={group} favorites={favorites} />
    </div>
  );
}

/** A small row for "Starred" and "Recently opened": the exact report that was opened, and its category. */
export function CompactLink({ report, category }: { report: ReportMeta; category: string }) {
  const Icon = iconFor(report.icon);
  const style = categoryStyle(report.category);
  return (
    <Link
      href={hrefFor(report.id)}
      data-testid={`report-link-${report.id}`}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-[#006496]/10 bg-white px-3 py-2.5 shadow-sm transition-all hover:border-[#006496]/30 hover:shadow-md",
        FOCUS,
      )}
    >
      <span
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1",
          style.chip,
          style.ring,
        )}
      >
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-bold text-[#1a3a4a]">{report.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{category}</span>
      </span>
    </Link>
  );
}
