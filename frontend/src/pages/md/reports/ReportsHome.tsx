import { useEffect, useMemo, useRef } from "react";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import type { ReportCatalog } from "@/lib/report-center";
import { ExecutiveShelf } from "./ExecutiveShelf";
import { ReportLibrary } from "./ReportLibrary";
import { ReportsHeader } from "./ReportsHeader";
import { YourReports } from "./YourReports";
import { buildLibrary, libraryContext } from "./report-library";

/**
 * The front door: the executive reports shelf, the reports this person keeps coming back to, then the whole library.
 * `scrollToTop` is set when the MD has just come back from an open report (the page is still scrolled where the report
 * was); a first visit starts at the top anyway and the layout restores the position on a return from another page.
 */
export function ReportsHome({ catalog, scrollToTop }: { catalog: ReportCatalog; scrollToTop: boolean }) {
  const library = useMemo(() => buildLibrary(catalog), [catalog]);
  const top = useRef<HTMLDivElement>(null);

  usePublishAssistantContext(useMemo(() => libraryContext(library), [library]));
  useEffect(() => {
    if (scrollToTop) top.current?.scrollIntoView?.({ block: "start" });
  }, [scrollToTop]);

  return (
    <div className="space-y-7" ref={top} data-testid="md-reports-home">
      <ReportsHeader />
      <ExecutiveShelf groups={library.executive} />
      <YourReports library={library} />
      <ReportLibrary library={library} />
    </div>
  );
}
