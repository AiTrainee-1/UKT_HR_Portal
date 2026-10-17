import { Redirect, Route, Switch, useSearch } from "wouter";
import CompensationLeavePage from "./compensation/pages/CompensationLeavePage";
import CtcBreakdownPage from "./compensation/pages/CtcBreakdownPage";
import HistoryPage from "./compensation/pages/HistoryPage";
import OtDetectionPage from "./compensation/pages/OtDetectionPage";
import ReportsPage from "./compensation/pages/ReportsPage";
import { COMPENSATION_BASE, legacyCompensationTarget, pagePath } from "./compensation/routes";

/**
 * The old `/hr/compensation?tab=ot&sub=...` address (and the bare `/hr/compensation`, and any path under it that is not a
 * page): sent to its new path with every other query parameter carried over. Replaces the entry, so Back does not bounce.
 */
function LegacyAddress() {
  const search = useSearch();
  return <Redirect to={legacyCompensationTarget(search)} replace />;
}

/**
 * Compensation is five pages under /hr/compensation, each with its own address and its own entry in the sidebar:
 * CTC Breakdown, OT Detection, Compensation Leave, History and Reports. The three with subtabs keep the subtab in the path
 * (/ot-detection/type-1), and a subtab with several sections keeps its nested subtab there too (/ot-detection/type-1/allowance);
 * the bare page (or subtab) redirects to the first one. App.tsx gates the whole prefix with the one
 * `compensation` permission module, so every page here is hidden together for a role that cannot see it.
 */
export default function Compensation() {
  return (
    <Switch>
      <Route path={`${pagePath("ctc")}/*?`} component={CtcBreakdownPage} />
      <Route path={`${pagePath("ot")}/*?`} component={OtDetectionPage} />
      <Route path={`${pagePath("leave")}/*?`} component={CompensationLeavePage} />
      <Route path={`${pagePath("history")}/*?`} component={HistoryPage} />
      <Route path={`${pagePath("reports")}/*?`} component={ReportsPage} />
      <Route path={COMPENSATION_BASE} component={LegacyAddress} />
      <Route component={LegacyAddress} />
    </Switch>
  );
}
