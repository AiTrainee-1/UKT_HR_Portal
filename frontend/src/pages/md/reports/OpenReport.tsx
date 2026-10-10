import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import type { ReportCatalog } from "@/lib/report-center";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { ReportNavRail } from "@/pages/hr/report-center/ReportNavRail";
import { ReportWorkspace } from "@/pages/hr/report-center/ReportWorkspace";
import { PrintButton, PrintSheet } from "./PrintSheet";
import { ReportsHeader } from "./ReportsHeader";
import { MD_REPORTS_PATH, askAboutReport, categoryLabel, executiveFirst, reportContext } from "./report-library";
import { useOpenReport } from "./useOpenReport";
import { usePrint } from "./usePrint";

type SetParams = (next: URLSearchParams, opts?: { replace?: boolean }) => void;

/**
 * One report inside the MD portal: the Report Center's own workspace (filters, KPI strip, table, PDF and Excel),
 * unchanged, with its links pointed at /md/reports, the report list as a rail beside it (a drawer on a phone), and what
 * an executive adds: Print (all rows, no screen furniture) and Ask AI about what is on screen.
 */
export function OpenReport({
  catalog,
  reportId,
  params,
  setParams,
}: {
  catalog: ReportCatalog;
  reportId: string;
  params: URLSearchParams;
  setParams: SetParams;
}) {
  const { spec, run, data, canPrint } = useOpenReport(catalog, reportId, params);
  const { printing, print } = usePrint();
  const [railOpen, setRailOpen] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const category = spec ? categoryLabel(catalog.categories, spec.category) : "";
  // The MD's own reports lead the list beside an open report, as they lead the library.
  const railCatalog = useMemo(() => executiveFirst(catalog), [catalog]);
  // While the browser prints, the sheet replaces the screen; if there is nothing to put on it (still loading, an error,
  // no rows) the screen prints as it is rather than a blank page.
  const sheet = printing && !!spec && !!data && data.rows.length > 0 && !run.isFetching;

  usePublishAssistantContext(
    spec ? reportContext(spec, category, data) : { page: "reports", title: "Reports", filters: { Report: reportId } },
  );

  // The workspace scrolls itself to its own top when a report opens, which hides this page's title row (and with it
  // "Browse reports", "Ask AI" and "Refresh"). This runs after it does, so the whole page, header first, is what shows.
  useEffect(() => {
    top.current?.scrollIntoView?.({ block: "start" });
  }, [reportId]);

  return (
    <>
      <div ref={top} className={cn("space-y-5", sheet && "print:hidden")} data-testid="md-report-screen">
        <ReportsHeader
          actions={
            <>
              <Sheet open={railOpen} onOpenChange={setRailOpen}>
                <SheetTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="@4xl:hidden">
                    <PanelLeft /> Browse reports
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-80 overflow-y-auto" {...{ [VIEW_SAFE_ATTR]: "" }}>
                  <SheetHeader>
                    <SheetTitle>Reports</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4">
                    <ReportNavRail
                      catalog={railCatalog}
                      activeId={reportId}
                      basePath={MD_REPORTS_PATH}
                      onNavigate={() => setRailOpen(false)}
                    />
                  </div>
                </SheetContent>
              </Sheet>
              {spec && <AskAiButton size="md" label="Ask AI about this report" question={askAboutReport(spec, data)} />}
            </>
          }
        />

        <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="hidden @4xl:block">
            <div className="clay-card sticky top-2 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-2xl p-3">
              <ReportNavRail catalog={railCatalog} activeId={reportId} basePath={MD_REPORTS_PATH} />
            </div>
          </aside>
          <ReportWorkspace
            reportId={reportId}
            params={params}
            setParams={setParams}
            catalog={catalog}
            basePath={MD_REPORTS_PATH}
            extraActions={<PrintButton onPrint={print} disabled={!canPrint} />}
          />
        </div>
      </div>

      {sheet && spec && data && <PrintSheet spec={spec} data={data} categoryLabel={category} />}
    </>
  );
}
