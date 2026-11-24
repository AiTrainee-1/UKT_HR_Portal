import { CheckCircle2, FileText, Hourglass, QrCode, Settings2, XCircle } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { DateRangeBar, type DateRange } from "@/components/date-range";
import { Button } from "@/components/ui/button";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { useOutpassQr, useOutpassRecordsForDays, useOutpassRequestsForDays } from "@/lib/api-client/custom-hooks";
import type { DateRangeValue } from "@/lib/date-range";
import { GateQrDialog } from "../GateQrDialog";
import { StatRow, StatTile } from "../kit";
import { gateTabPath, type GateTab } from "../routes";
import { BranchPicker, PAGE_SIZE, type useSelectedBranch } from "../shared";
import { passesForDays, type PassFilterStatus } from "./logic";
import { ApprovedPassesSection } from "./PassesSection";
import { QrSubmissionsSection } from "./QrSubmissionsSection";

const OVERVIEW_BASE = gateTabPath("outpass", "overview");
const GATES_PATH = gateTabPath("outpass", "gates");

type Branches = ReturnType<typeof useSelectedBranch>;
export type PassFilters = { status: PassFilterStatus; q: string };

/**
 * Overview: the passes of the dates at a glance (tiles that also filter the Passes list), the HR portal's date filter
 * (Today / Yesterday / This Month, an earlier month, Custom days; This Month by default) with the gate tools (the branch's
 * gate QR, and a way to Manage Gates when that tab is open to the role), and under them one section at a time: the passes
 * that go through approval, or the exits logged through the QR form. A pass is for the day the employee went out (the day
 * it was asked for until they go); a QR exit for the day it was logged. The server sends only the days' rows, and the
 * tiles and the filter stay above the two sections, so the dates you picked are still there when you switch.
 */
export function OverviewSection({
  nested,
  sections,
  isBranchScoped,
  branch,
  dates,
  onDates,
  page,
  setPage,
  passesCount,
  passFilters,
  onPassFilters,
  canManageGates,
}: {
  nested: string;
  /** The nested subtabs this role may see (each has its own key and address). */
  sections: readonly GateTab[];
  isBranchScoped: boolean;
  branch: Branches;
  dates: DateRange;
  onDates: (next: DateRangeValue) => void;
  page: number;
  setPage: (page: number) => void;
  passesCount: number | undefined;
  passFilters: PassFilters;
  onPassFilters: (patch: Partial<PassFilters>) => void;
  /** The Manage Gates tab is open to this role: offer a way there. */
  canManageGates: boolean;
}) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { branches, branchId, setBranchId } = branch;
  const effectiveBranchId = isBranchScoped ? undefined : branchId ? Number(branchId) : undefined;
  const { data: qr } = useOutpassQr(effectiveBranchId, { enabled: isBranchScoped || effectiveBranchId !== undefined });
  const { data: records, isLoading: recordsLoading } = useOutpassRecordsForDays(dates.days, page, PAGE_SIZE);
  // the same call as the Passes list and the tab counts (one cache entry): here it fills the tiles
  const { data: requests, isLoading: requestsLoading } = useOutpassRequestsForDays(dates.days);

  const inRange = requests ? passesForDays(requests, dates.days) : undefined;
  const count = (status: string) => inRange?.filter((r) => r.status === status).length;
  const passesOpen = sections.some((s) => s.value === "passes");
  const go = (path: string) => navigate(`${path}${search ? `?${search}` : ""}`);
  // a tile filters the Passes list by its status (a second click shows them all again), opening Passes if needed
  const passTile = (status: PassFilterStatus) =>
    passesOpen
      ? {
          onClick: () => {
            onPassFilters({ status: passFilters.status === status ? "" : status });
            if (nested !== "passes") go(`${OVERVIEW_BASE}/passes`);
          },
          active: status !== "" && passFilters.status === status,
        }
      : {};
  const qrOpen = sections.some((s) => s.value === "qr-submissions");

  return (
    <div className="space-y-4" data-testid="outpass-overview">
      <StatRow testId="overview-tiles">
        <StatTile
          label="Passes"
          value={inRange?.length}
          icon={FileText}
          loading={requestsLoading}
          testId="overview-tile-passes"
          title={`Every pass for ${dates.label}`}
          {...passTile("")}
        />
        <StatTile
          label="Waiting"
          value={count("pending")}
          icon={Hourglass}
          tone="indigo"
          loading={requestsLoading}
          testId="overview-tile-waiting"
          title="Waiting for a decision"
          {...passTile("pending")}
        />
        <StatTile
          label="Approved"
          value={count("approved")}
          icon={CheckCircle2}
          tone="teal"
          loading={requestsLoading}
          testId="overview-tile-approved"
          {...passTile("approved")}
        />
        <StatTile
          label="Rejected"
          value={count("rejected")}
          icon={XCircle}
          tone="rose"
          loading={requestsLoading}
          testId="overview-tile-rejected"
          {...passTile("rejected")}
        />
        <StatTile
          label="Gate QR submissions"
          value={records?.total}
          icon={QrCode}
          tone="slate"
          loading={recordsLoading}
          testId="overview-tile-qr"
          title="Exits logged through the branch QR form"
          {...(qrOpen ? { onClick: () => go(`${OVERVIEW_BASE}/qr-submissions`) } : {})}
        />
      </StatRow>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangeBar value={dates.value} onChange={onDates} testId="overview-dates" />
        <div className="flex flex-wrap items-center gap-2">
          {!isBranchScoped && <BranchPicker branches={branches} branchId={branchId} setBranchId={setBranchId} />}
          {canManageGates && (
            <Button
              variant="outline"
              size="sm"
              className="h-11 gap-1.5 sm:h-9"
              onClick={() => go(GATES_PATH)}
              data-testid="overview-manage-gates"
            >
              <Settings2 size={14} /> Manage Gates
            </Button>
          )}
          <GateQrDialog kind="outpass" token={qr?.token} branchName={qr?.branchName} />
        </div>
      </div>

      {sections.length === 0 ? (
        <p
          className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground"
          data-testid="nothing-open"
        >
          Neither section of the overview is open to your role.
        </p>
      ) : (
        <NestedTabs
          base={OVERVIEW_BASE}
          value={nested}
          testId="outpass-overview-nested"
          label="Sections of the Gate Pass overview"
          items={sections.map((n) => ({
            ...n,
            count: n.value === "passes" ? passesCount : records?.total,
          }))}
        >
          {nested === "passes" ? (
            <ApprovedPassesSection
              key={`${dates.days.from}_${dates.days.to}`}
              days={dates.days}
              rangeText={dates.label}
              status={passFilters.status}
              q={passFilters.q}
              onFilters={onPassFilters}
            />
          ) : (
            <QrSubmissionsSection
              rangeText={dates.label}
              records={records}
              isLoading={recordsLoading}
              setPage={setPage}
            />
          )}
        </NestedTabs>
      )}
    </div>
  );
}
