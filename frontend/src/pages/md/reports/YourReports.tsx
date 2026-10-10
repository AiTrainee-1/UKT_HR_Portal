import type { ReactNode } from "react";
import { Clock, Star } from "lucide-react";
import { MAX_RECENT, useReportPrefs } from "@/lib/report-prefs";
import { CompactLink } from "./ReportCards";
import { categoryLabel, pickReports, type Library, type PickedReport } from "./report-library";

function Strip({
  title,
  icon,
  testId,
  items,
  library,
}: {
  title: string;
  icon: ReactNode;
  testId: string;
  items: PickedReport[];
  library: Library;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} data-testid={testId}>
      <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-md-ink-soft">
        {icon} {title}
      </h3>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
        {items.map(({ report }) => (
          <CompactLink
            key={report.id}
            report={report}
            category={categoryLabel(library.allCategories, report.category)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The reports this person comes back to: the ones they starred, and the last few they opened (kept in this browser,
 * shared with the HR portal's Report Center, which opens the same reports). Reports the catalog no longer lists are
 * left out, and nothing is drawn when there is nothing to show.
 */
export function YourReports({ library }: { library: Library }) {
  const { favorites, recents } = useReportPrefs();
  const starred = pickReports(favorites, library.all, MAX_RECENT);
  const recent = pickReports(recents, library.all, MAX_RECENT);
  if (starred.length === 0 && recent.length === 0) return null;
  return (
    <div className="space-y-5" data-testid="md-your-reports">
      <Strip
        title="Starred"
        icon={<Star size={13} className="fill-md-warning-400 text-md-warning-500" aria-hidden />}
        testId="md-starred"
        items={starred}
        library={library}
      />
      <Strip
        title="Recently opened"
        icon={<Clock size={13} aria-hidden />}
        testId="md-recent"
        items={recent}
        library={library}
      />
    </div>
  );
}
