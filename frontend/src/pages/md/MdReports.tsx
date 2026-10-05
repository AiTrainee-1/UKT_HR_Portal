import { useEffect, useRef } from "react";
import { useSearchParams } from "wouter";
import MdLayout from "@/components/md/MdLayout";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { useReportCatalog } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { OpenReport } from "./reports/OpenReport";
import { ReportsHeader } from "./reports/ReportsHeader";
import { ReportsHome } from "./reports/ReportsHome";
import { catalogFailure } from "./reports/report-library";

/**
 * The MD's Reports page (/md/reports): executive reports on a shelf, then the whole Report Center, read-only. The Report
 * Center itself is the HR portal's, embedded as it is (its catalog, filters, table and PDF/Excel exports), so the two
 * can never disagree; what is added here is the MD's front door and printing. A report and its filters live in the URL
 * (?report=<id>&run=1&<filters>), exactly as in the HR portal. Everything on this page only reads, so the root carries
 * data-view-safe, as the HR Reports page does.
 */
export default function MdReports() {
  const [params, setParams] = useSearchParams();
  const catalog = useReportCatalog();
  const reportId = params.get("report");

  // Has an open report just been closed? Then the library should open at its top, not where the report was scrolled.
  const cameFromReport = useRef(false);
  if (reportId) cameFromReport.current = true;
  useEffect(() => {
    if (!reportId) cameFromReport.current = false;
  }, [reportId]);

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-reports" {...{ [VIEW_SAFE_ATTR]: "" }}>
        {!catalog.data ? (
          <>
            <ReportsHeader />
            {catalog.isPending ? (
              <SectionCard
                title="Report library"
                subtitle="Loading the reports you can open"
                loading
                bodyClassName="min-h-[240px]"
                testId="md-reports-loading"
              />
            ) : (
              <ErrorBanner message={catalogFailure(catalog.error)} onRetry={() => catalog.refetch()} />
            )}
          </>
        ) : reportId ? (
          <OpenReport catalog={catalog.data} reportId={reportId} params={params} setParams={setParams} />
        ) : (
          <ReportsHome catalog={catalog.data} scrollToTop={cameFromReport.current} />
        )}
      </div>
    </MdLayout>
  );
}
