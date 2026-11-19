import { SubtabBar } from "@/components/ui/subtab-nav";
import { useTeaBreakOptions, useTeaBreakRule } from "@/lib/api-client/custom-hooks";
import { useLevel, visibleItems } from "@/lib/tab-access";
import { gateKey, gatePagePath, subsOf } from "../routes";
import { TeaBreakRecords } from "./TeaBreakRecords";
import { TeaBreakRuleCard } from "./TeaBreakRule";

// ── Tea Break ────────────────────────────────────────────────────────────────
// A permanent per-employee QR, no approval (backend tea_break_views.py): the same gates that scan gate passes record a
// break's out and back scans. This page lists those breaks (Records: figures, filters, the breaks or the employee-wise
// view, details, Excel / PDF) and holds the one rule (Rule: the allowed minutes).

export { TeaBreakRuleCard };

/**
 * The page under the heading: the Records / Rule strip (each an address with its own permission key), then the open tab.
 * Records keeps its filters in the address, so they are still set after a trip to the Rule tab and back.
 */
export function TeaBreakTab({ sub }: { sub: string }) {
  // only the tabs this role may see are offered; the page lands on the first of them (routes.ts)
  const level = useLevel();
  const subs = visibleItems(subsOf("tea-break"), (s) => gateKey("tea-break", s.value), level);

  return (
    <div className="space-y-4" data-testid="tea-break-tab">
      <SubtabBar base={gatePagePath("tea-break")} value={sub} testId="tea-break-subtabs" items={[...subs]} />
      {sub === "rule" ? <TeaBreakRuleCard /> : <TeaBreakRecords />}
    </div>
  );
}

/**
 * The heading's one-line subtitle, with the allowed minutes of the rule (from the rule when the role may see the Rule
 * tab, else from the records' options). A role that may see neither tab asks for nothing.
 */
export function TeaBreakSubtitle() {
  const level = useLevel();
  const ruleOpen = level(gateKey("tea-break", "rule")) !== "hidden";
  const recordsOpen = level(gateKey("tea-break", "records")) !== "hidden";
  const rule = useTeaBreakRule({ enabled: ruleOpen });
  const options = useTeaBreakOptions("", { enabled: recordsOpen && !ruleOpen });
  const allowed = ruleOpen ? rule.data?.allowedMinutes : options.data?.allowedMinutes;
  return (
    <>
      Tea-break out and back times scanned at the gate.
      {allowed ? <span data-testid="tea-break-allowed"> Allowed: {allowed} min.</span> : null}
    </>
  );
}
