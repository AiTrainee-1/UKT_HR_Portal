import { useState } from "react";
import { useSearchParams } from "wouter";
import { BarChart3, PanelLeft } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useReportCatalog } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { ReportCatalogView } from "./report-center/ReportCatalogView";
import { ReportNavRail } from "./report-center/ReportNavRail";
import { ErrorState } from "./report-center/ReportStates";
import { ReportWorkspace } from "./report-center/ReportWorkspace";

/**
 * Report Center (/hr/reports). Everything on this page only READS data, so the page root carries
 * data-view-safe: a View Only role can still run and download reports (the API allows it too - every
 * report endpoint is a GET). The report and its filters live in the URL: ?report=<id>&run=1&<filters>.
 */
export default function Reports() {
  const [params, setParams] = useSearchParams();
  const catalog = useReportCatalog();
  const [railOpen, setRailOpen] = useState(false);
  const reportId = params.get("report");

  const setSearch = (next: URLSearchParams, opts?: { replace?: boolean }) => setParams(next, opts);

  return (
    <HrLayout>
      <div className="space-y-5" {...{ [VIEW_SAFE_ATTR]: "" }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <BarChart3 size={22} className="text-sky-700" /> Reports
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Payroll, attendance, leave, gate and employee reports - filter, view, and download as PDF or Excel.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {reportId && catalog.data && (
              <Sheet open={railOpen} onOpenChange={setRailOpen}>
                <SheetTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="lg:hidden">
                    <PanelLeft /> Browse reports
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-80 overflow-y-auto" {...{ [VIEW_SAFE_ATTR]: "" }}>
                  <SheetHeader>
                    <SheetTitle>Reports</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4">
                    <ReportNavRail catalog={catalog.data} activeId={reportId} onNavigate={() => setRailOpen(false)} />
                  </div>
                </SheetContent>
              </Sheet>
            )}
            <RefreshButton />
          </div>
        </div>

        {catalog.isLoading ? (
          <div className="flex justify-center py-20">
            <ShieldLoader size={96} />
          </div>
        ) : catalog.isError || !catalog.data ? (
          <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} />
        ) : reportId ? (
          <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            <aside className="hidden lg:block">
              <div className="sticky top-2 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-xl border bg-white p-3 shadow-sm">
                <ReportNavRail catalog={catalog.data} activeId={reportId} />
              </div>
            </aside>
            <ReportWorkspace reportId={reportId} params={params} setParams={setSearch} catalog={catalog.data} />
          </div>
        ) : (
          <ReportCatalogView catalog={catalog.data} />
        )}
      </div>
    </HrLayout>
  );
}
