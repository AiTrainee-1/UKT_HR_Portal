import { useState } from "react";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { SubtabBar } from "@/components/ui/subtab-nav";
import {
  useListOutpassRequests,
  useOutpassQr,
  useOutpassRecords,
  useOutpassSummary,
  type GateRange,
} from "@/lib/api-client/custom-hooks";
import { hrCanAct } from "@/lib/approval-workflow";
import { inGateRange } from "@/lib/gate-range";
import { GateDevicesDialog } from "../GateDevicesDialog";
import { GateQrDialog } from "../GateQrDialog";
import { gatePagePath, gateTabPath, nestedOf, subsOf } from "../routes";
import { BranchPicker, KpiRow, PAGE_SIZE, RangeFilter, useSelectedBranch } from "../shared";
import { InOutSection } from "./InOutSection";
import { ApprovedPassesSection } from "./PassesSection";
import { QrSubmissionsSection } from "./QrSubmissionsSection";
import { OutpassRequestsSection } from "./RequestsSection";

const OUTPASS_BASE = gatePagePath("outpass");
const OVERVIEW_BASE = gateTabPath("outpass", "overview");

type Branches = ReturnType<typeof useSelectedBranch>;

/**
 * Overview: the gate QR's headline tiles, the Today / This Week / This Month filter with the gate tools, and under them one
 * section at a time: the passes that go through approval, or the exits logged through the QR form. The tiles and the filter
 * stay above the two tabs, so the range you picked is still there when you switch.
 */
function Overview({
  nested,
  isBranchScoped,
  branch,
  range,
  onRange,
  page,
  setPage,
  passesCount,
}: {
  nested: string;
  isBranchScoped: boolean;
  branch: Branches;
  range: GateRange;
  onRange: (range: GateRange) => void;
  page: number;
  setPage: (page: number) => void;
  passesCount: number | undefined;
}) {
  const { branches, branchId, setBranchId } = branch;
  const effectiveBranchId = isBranchScoped ? undefined : branchId ? Number(branchId) : undefined;
  const { data: qr } = useOutpassQr(effectiveBranchId);
  const { data: summary, isLoading: summaryLoading } = useOutpassSummary();
  const { data: records, isLoading: recordsLoading } = useOutpassRecords(range, page, PAGE_SIZE);

  return (
    <div className="space-y-4" data-testid="outpass-overview">
      <KpiRow summary={summary} isLoading={summaryLoading} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeFilter value={range} onChange={onRange} />
        <div className="flex flex-wrap items-center gap-2">
          {!isBranchScoped && <BranchPicker branches={branches} branchId={branchId} setBranchId={setBranchId} />}
          <GateDevicesDialog isBranchScoped={isBranchScoped} branches={branches} defaultBranchId={branchId} />
          <GateQrDialog kind="outpass" token={qr?.token} branchName={qr?.branchName} />
        </div>
      </div>

      <NestedTabs
        base={OVERVIEW_BASE}
        value={nested}
        testId="outpass-overview-nested"
        label="Sections of the Outpass overview"
        items={nestedOf("outpass", "overview").map((n) => ({
          ...n,
          count: n.value === "passes" ? passesCount : records?.total,
        }))}
      >
        {nested === "passes" ? (
          <ApprovedPassesSection key={range} range={range} />
        ) : (
          <QrSubmissionsSection range={range} records={records} isLoading={recordsLoading} setPage={setPage} />
        )}
      </NestedTabs>
    </div>
  );
}

/**
 * The Outpass page: three subtabs, each with its own address: Overview (with nested Passes / Gate QR submissions), Requests
 * (the pending ones to decide) and In/Out (every gate exit and return). The range, the branch and the page of the QR
 * submissions live here, above the panels, so switching tabs keeps them.
 */
export function OutpassTab({
  isBranchScoped,
  sub,
  nested,
}: {
  isBranchScoped: boolean;
  sub: string;
  /** The nested subtab of Overview (the page redirects a missing or unknown one to the first before this renders). */
  nested: string | null;
}) {
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);
  const branch = useSelectedBranch(isBranchScoped);
  const changeRange = (next: GateRange) => {
    setRange(next);
    setPage(1);
  };

  // One identical call each shares its cache with the panel that lists them: here they only put a live count on the pills.
  const { data: pendingRequests } = useListOutpassRequests("pending");
  const { data: allRequests } = useListOutpassRequests();
  const pending = pendingRequests ? pendingRequests.filter((r) => hrCanAct(r.approval, true)).length : undefined;
  const exits = allRequests ? allRequests.filter((r) => !!r.exitedAt).length : undefined;
  const passesCount = allRequests ? allRequests.filter((r) => inGateRange(r.createdAt, range)).length : undefined;

  const counts: Record<string, number | undefined> = { requests: pending || undefined, "in-out": exits };

  return (
    <div className="space-y-4" data-testid="outpass-tab">
      <SubtabBar
        base={OUTPASS_BASE}
        value={sub}
        testId="outpass-subtabs"
        items={subsOf("outpass").map((s) => ({ ...s, count: counts[s.value] }))}
        landing={(next) => nestedOf("outpass", next)[0]?.value}
      />

      {sub === "requests" ? (
        <OutpassRequestsSection />
      ) : sub === "in-out" ? (
        <InOutSection />
      ) : (
        <Overview
          nested={nested ?? nestedOf("outpass", "overview")[0].value}
          isBranchScoped={isBranchScoped}
          branch={branch}
          range={range}
          onRange={changeRange}
          page={page}
          setPage={setPage}
          passesCount={passesCount}
        />
      )}
    </div>
  );
}
