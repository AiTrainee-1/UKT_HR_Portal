import { useEffect, useMemo, useRef } from "react";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { monthFromParams, useUrlParams } from "@/lib/md/url-filters";
import type { ReportCatalog } from "@/lib/report-center";
import { ExecutiveShelf } from "./ExecutiveShelf";
import { ReportLibrary } from "./ReportLibrary";
import { ReportsHeader } from "./ReportsHeader";
import { ReportsOverview } from "./ReportsOverview";
import { YourReports } from "./YourReports";
import { buildLibrary, libraryContext, libraryStats } from "./report-library";

/**
 * The front door: the page at a glance, the executive reports shelf (with the month and unit they open for), the
 * reports this person keeps coming back to, then the whole library. The month, unit, search and group live in the
 * address. `scrollToTop` is set when the MD has just come back from an open report (the page is still scrolled where
 * the report was); a first visit starts at the top anyway and the layout restores the position on a return from
 * another page.
 */
export function ReportsHome({ catalog, scrollToTop }: { catalog: ReportCatalog; scrollToTop: boolean }) {
  const library = useMemo(() => buildLibrary(catalog), [catalog]);
  const stats = useMemo(() => libraryStats(library), [library]);
  const [params, update] = useUrlParams();
  const month = monthFromParams(params);
  const branch = params.get("unit") ?? "";
  const top = useRef<HTMLDivElement>(null);

  usePublishAssistantContext(useMemo(() => libraryContext(library), [library]));
  useEffect(() => {
    if (scrollToTop) top.current?.scrollIntoView?.({ block: "start" });
  }, [scrollToTop]);

  return (
    <div className="space-y-5 @lg:space-y-7" ref={top} data-testid="md-reports-home">
      <ReportsHeader />
      <ReportsOverview library={library} stats={stats} onGroup={(group) => update({ group, q: null })} />
      <ExecutiveShelf
        groups={library.executive}
        month={month}
        branch={branch}
        branches={catalog.options?.branches ?? []}
        onMonth={(m) => update({ month: m })}
        onBranch={(b) => update({ unit: b || null })}
      />
      <YourReports library={library} />
      <ReportLibrary library={library} />
    </div>
  );
}
