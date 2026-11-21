import { FileStack, Landmark, Layers, Star } from "lucide-react";
import BarList from "@/components/md/kit/BarList";
import StatCard from "@/components/md/kit/StatCard";
import { num } from "@/lib/md/format";
import { useReportPrefs } from "@/lib/report-prefs";
import { CUSTOMISE_CATEGORY, pickReports, type Library, type LibraryStats } from "./report-library";

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** The library in one sentence: what the MD can open, in how many groups, and their own pack. */
export function overviewSentence(s: LibraryStats): string {
  const saved = s.saved ? `, plus ${plural(s.saved, "saved custom report")}` : "";
  return `${plural(s.executive, "executive report")} prepared for you, and ${plural(s.listed, "report")} in ${plural(s.groups, "group")} of the Report Center${saved}. Choose a month above the executive reports to open them for that month.`;
}

/**
 * The Reports page at a glance: the executive pack, the Report Center's groups (each opens the library at that group),
 * the saved custom reports and what this person starred. Everything here comes from the catalog already loaded.
 */
export function ReportsOverview({
  library,
  stats,
  onGroup,
}: {
  library: Library;
  stats: LibraryStats;
  onGroup: (group: string | null) => void;
}) {
  const { favorites } = useReportPrefs();
  const starred = pickReports(favorites, library.all).length;
  const toLibrary = (group: string | null) => {
    onGroup(group);
    document.getElementById("md-report-library")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  return (
    <section aria-label="Reports at a glance" className="space-y-3" data-testid="md-reports-overview">
      <p className="text-[13px] leading-relaxed text-md-ink" data-testid="md-reports-overview-text">
        {overviewSentence(stats)}
      </p>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard
          label="Executive reports"
          value={num(stats.executive)}
          sub="Prepared for the Managing Director"
          icon={Landmark}
          tone="blue"
          testId="md-reports-kpi-executive"
        />
        <StatCard
          label="Report Center"
          value={num(stats.listed)}
          sub={`In ${plural(stats.groups, "group")}`}
          icon={Layers}
          tone="slate"
          onClick={() => toLibrary(null)}
          testId="md-reports-kpi-listed"
        />
        <StatCard
          label="Saved custom reports"
          value={num(stats.saved)}
          sub="Built by HR in Customise"
          icon={FileStack}
          tone="indigo"
          onClick={stats.saved ? () => toLibrary(CUSTOMISE_CATEGORY) : undefined}
          testId="md-reports-kpi-saved"
        />
        <StatCard
          label="Starred"
          value={num(starred)}
          sub="Your own shortlist"
          icon={Star}
          tone="amber"
          testId="md-reports-kpi-starred"
        />
      </div>
      {stats.byGroup.length > 0 && (
        <div className="md-card p-4">
          <p className="mb-3 text-[13px] font-extrabold text-md-ink">Reports by group</p>
          <BarList
            items={stats.byGroup.map((g) => ({ key: g.id, label: g.label, value: g.count }))}
            onSelect={(item) => toLibrary(item.key)}
            testId="md-reports-by-group"
          />
        </div>
      )}
    </section>
  );
}
