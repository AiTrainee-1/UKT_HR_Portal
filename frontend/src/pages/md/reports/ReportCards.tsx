import { Link } from "wouter";
import { ArrowRight, ArrowUpRight, Star } from "lucide-react";
import type { ReportGroup } from "@/lib/report-catalog";
import type { ReportMeta } from "@/lib/report-center";
import { toggleFavorite } from "@/lib/report-prefs";
import { cn } from "@/lib/utils";
import { reportHref } from "@/pages/hr/report-center/ReportCatalogView";
import { iconFor } from "@/pages/hr/report-center/report-icons";
import { categoryTone } from "./category-tone";
import { MD_REPORTS_PATH, starredIdOf } from "./report-library";

const hrefFor = (id: string) => reportHref(id, MD_REPORTS_PATH);

/** One of the MD's own reports: the shelf at the top of the page. A large glass card with a wine gradient icon tile, a
 *  plain-English description and where it leads; the card lifts on hover and its "Open report" pill fills in. */
export function ExecutiveCard({ group, order = 0 }: { group: ReportGroup; order?: number }) {
  const report = group.primary;
  const Icon = iconFor(report.icon);
  const views = group.variants.length;
  return (
    <Link
      href={hrefFor(report.id)}
      data-testid={`executive-card-${report.id}`}
      className="md-card md-money-exec md-money-t-wine motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 motion-safe:fill-mode-backwards"
      style={order ? { animationDelay: `${order * 40}ms` } : undefined}
    >
      <span className="md-money-tile md-money-tile-solid md-money-tile-lg">
        <Icon size={22} aria-hidden />
      </span>
      <span className="mt-4 text-[17px] font-black leading-snug tracking-tight text-md-ink">{report.title}</span>
      <span className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-md-ink-soft">{report.description}</span>
      <span className="mt-auto flex items-center gap-2 pt-5">
        {views > 1 && <span className="md-chip md-chip-sand">{views} views</span>}
        <span className="md-money-cta ml-auto">
          Open report <ArrowRight size={14} aria-hidden />
        </span>
      </span>
    </Link>
  );
}

/** A report's star: starred reports are kept under "Starred" at the top of the page. A round glass icon button; a starred
 *  report's star is filled in ochre, the warm highlight. */
function StarButton({ group, favorites }: { group: ReportGroup; favorites: string[] }) {
  const starred = starredIdOf(group, favorites);
  return (
    <div className="absolute right-2.5 top-2.5">
      <button
        type="button"
        aria-label={starred ? "Unstar this report" : "Star this report"}
        aria-pressed={!!starred}
        onClick={() => toggleFavorite(starred ?? group.primary.id)}
        className="md-btn md-btn-ghost md-btn-icon"
      >
        <Star size={16} className={starred ? "fill-md-warning-400 text-md-warning-500" : "text-md-ink-soft"} />
      </button>
    </div>
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
  const tone = categoryTone(report.category);
  const views = group.variants.length;
  return (
    <div className="group relative" data-testid={`report-card-${report.id}`}>
      <Link href={hrefFor(report.id)} className={cn("md-money-card", tone.tone)}>
        <span className="md-money-tile">
          <Icon size={18} aria-hidden />
        </span>
        <span className="mt-3.5 text-[14.5px] font-extrabold leading-snug tracking-tight text-md-ink">
          {report.title}
        </span>
        <span className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-md-ink-soft">{report.description}</span>
        <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-3.5 text-[11.5px] font-semibold">
          {category && (
            <span className="inline-flex items-center gap-1.5 text-md-ink-soft">
              <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
              {category}
            </span>
          )}
          {views > 1 && (
            <span className="md-chip md-chip-sand max-w-full">
              <span className="truncate">
                {views} views: {group.variants.map((v) => v.variant).join(" · ")}
              </span>
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-0.5 font-extrabold text-md-wine">
            Open{" "}
            <ArrowUpRight
              size={13}
              className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              aria-hidden
            />
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
  const tone = categoryTone(report.category);
  return (
    <Link
      href={hrefFor(report.id)}
      data-testid={`report-link-${report.id}`}
      className={cn("md-money-card md-money-card-row", tone.tone)}
    >
      <span className="md-money-tile md-money-tile-sm">
        <Icon size={16} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-extrabold text-md-ink">{report.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] font-medium text-md-ink-soft">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
          <span className="truncate">{category}</span>
        </span>
      </span>
    </Link>
  );
}
