import { Redirect, useSearch } from "wouter";

/** /md/settlement, the page's address until it was renamed Loan & Advance (2026-11-27): goes to /md/loan-advance with the
 *  same query (?month=, ?type=, ?batch=, ?view=), so an old link or bookmark still opens the same view. Tiny on purpose:
 *  App.tsx imports it directly. */
export default function LegacySettlementRedirect() {
  const search = useSearch();
  return <Redirect to={`/md/loan-advance${search ? `?${search}` : ""}`} replace />;
}
