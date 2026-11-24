import { useState } from "react";
import { useDateRange } from "@/components/date-range";
import { SubtabBar, type SubtabOwnKeys } from "@/components/ui/subtab-nav";
import { useInOutSummary, useListOutpassRequests, useOutpassRequestsForDays } from "@/lib/api-client/custom-hooks";
import { hrCanAct } from "@/lib/approval-workflow";
import { DATE_RANGE_KEYS, type DateRangeValue } from "@/lib/date-range";
import { useLevel, visibleItems } from "@/lib/tab-access";
import { GATE_PAGE_DEFAULTS } from "../gates/GateRecords";
import { ManageGatesPage } from "../gates/ManageGatesPage";
import { istDateKey } from "../kit";
import { gateKey, gatePagePath, nestedOf, subsOf } from "../routes";
import { useSelectedBranch } from "../shared";
import { IN_OUT_DEFAULTS, InOutSection } from "./InOutSection";
import { passesForDays } from "./logic";
import { OverviewSection, type PassFilters } from "./OverviewSection";
import { OutpassRequestsSection } from "./RequestsSection";

const OUTPASS_BASE = gatePagePath("outpass");

// In/Out and Manage Gates keep their lists' filters in the address under the same names for different lists (`q`, the
// dates, `gateId`, `page`): a switch leaves each tab's keys with it and gives them back when it is opened again, so
// In/Out's search never filters the gate records (or the other way round). Overview owns its date filter's keys (the HR
// portal's range / month / from / to, 2026-11-24) for the same reason; Requests owns none.
const OWN_KEYS: SubtabOwnKeys = {
  overview: [...DATE_RANGE_KEYS],
  "in-out": [...Object.keys(IN_OUT_DEFAULTS), "page"],
  gates: [...Object.keys(GATE_PAGE_DEFAULTS), "page"],
};

// Manage Gates: the gates, their logins, settings and records (gates/ManageGatesPage.tsx, root test id "outpass-gates").
function ManageGatesPanel() {
  return <ManageGatesPage />;
}

/**
 * The Gate Pass page: four subtabs, each with its own address: Overview (with nested Passes / Gate QR submissions),
 * Requests (the pending ones to decide), In/Out (every gate exit and return) and Manage Gates (the gates and their
 * logins). The branch, the page of the QR submissions and the Passes search live here, above the panels, so switching
 * tabs keeps them; the Overview's dates (the HR portal's date filter: This Month by default, Today, Yesterday, an earlier
 * month or Custom days) are in the address, so a reload or Back keeps them too (In/Out and Manage Gates keep their own
 * filters in the address, see OWN_KEYS).
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
  const dates = useDateRange();
  const [page, setPage] = useState(1);
  const [passFilters, setPassFilters] = useState<PassFilters>({ status: "", q: "" });
  const branch = useSelectedBranch(isBranchScoped);
  // only the subtabs (and Overview sections) this role may see are offered; the page lands on the first of them (routes.ts)
  const level = useLevel();
  const subs = visibleItems(subsOf("outpass"), (s) => gateKey("outpass", s.value), level);
  const sectionsOf = (next: string) =>
    visibleItems(nestedOf("outpass", next), (n) => gateKey("outpass", next, n.value), level);
  const sections = sectionsOf("overview");
  const visible = (value: string) => subs.some((s) => s.value === value);
  const changeDates = (next: DateRangeValue) => {
    dates.set(next);
    setPage(1);
  };

  // One identical call each shares its cache with the panel that lists them: here they only put a live count on the pills.
  // (Both read the Requests module's list; In/Out and Manage Gates have data of their own and do not need the whole list.)
  const onOverview = sub !== "requests" && sub !== "in-out" && sub !== "gates";
  const { data: pendingRequests } = useListOutpassRequests("pending", { enabled: visible("requests") });
  const { data: dayRequests } = useOutpassRequestsForDays(dates.days, { enabled: onOverview });
  const pending = pendingRequests ? pendingRequests.filter((r) => hrCanAct(r.approval, true)).length : undefined;
  const passesCount = dayRequests ? passesForDays(dayRequests, dates.days).length : undefined;
  // In/Out counts the people still out right now (today's figures; the same call as In/Out's tiles on a fresh visit)
  const today = istDateKey();
  const { data: outToday } = useInOutSummary(new URLSearchParams({ from: today, to: today }).toString(), {
    enabled: visible("in-out"),
  });

  const counts: Record<string, number | undefined> = {
    requests: pending || undefined,
    "in-out": outToday?.stillOut || undefined,
  };

  return (
    <div className="space-y-4" data-testid="outpass-tab">
      <SubtabBar
        base={OUTPASS_BASE}
        value={sub}
        testId="outpass-subtabs"
        items={subs.map((s) => ({ ...s, count: counts[s.value] }))}
        landing={(next) => sectionsOf(next)[0]?.value}
        ownKeys={OWN_KEYS}
      />

      {sub === "requests" ? (
        <OutpassRequestsSection />
      ) : sub === "in-out" ? (
        <InOutSection isBranchScoped={isBranchScoped} />
      ) : sub === "gates" ? (
        <ManageGatesPanel />
      ) : (
        <OverviewSection
          nested={nested ?? sections[0]?.value ?? ""}
          sections={sections}
          isBranchScoped={isBranchScoped}
          branch={branch}
          dates={dates}
          onDates={changeDates}
          page={page}
          setPage={setPage}
          passesCount={passesCount}
          passFilters={passFilters}
          onPassFilters={(patch) => setPassFilters((current) => ({ ...current, ...patch }))}
          canManageGates={visible("gates")}
        />
      )}
    </div>
  );
}
