import { SubtabBar } from "@/components/ui/subtab-nav";
import { useLevel, visibleItems } from "@/lib/tab-access";
import { gateKey, gatePagePath, subsOf } from "../routes";
import { ManageReceptionPage } from "./desks/ManageReceptionPage";
import { VisitorsTab } from "./VisitorsTab";

/**
 * Visitors under its heading: the Visitors / Manage Reception strip (each an address with its own permission key:
 * outpass_visitors.visitors.visits, and outpass_visitors.visitors.desks, which follows "Reception desk devices" while a role
 * sets nothing on it), then the open tab. The two keep their filters under different address keys, so a trip from one to
 * the other and back changes neither.
 */
export function VisitorsPage({ isBranchScoped, sub }: { isBranchScoped: boolean; sub: string }) {
  // only the tabs this role may see are offered; the page lands on the first of them (routes.ts)
  const level = useLevel();
  const subs = visibleItems(subsOf("visitors"), (s) => gateKey("visitors", s.value), level);

  return (
    <div className="space-y-4" data-testid="visitors-tab">
      <SubtabBar base={gatePagePath("visitors")} value={sub} testId="visitors-subtabs" items={[...subs]} />
      {sub === "desks" ? <ManageReceptionPage /> : <VisitorsTab isBranchScoped={isBranchScoped} />}
    </div>
  );
}
