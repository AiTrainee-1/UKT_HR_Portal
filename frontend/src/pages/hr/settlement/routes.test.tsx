import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LEGACY_SETTLEMENT_BASE,
  LOAN_ADVANCE_BASE,
  LOAN_ADVANCE_BASE_ENCODED,
  LOAN_ADVANCE_PAGES,
  legacySettlementTarget,
  loanAdvancePageOf,
  loanAdvancePath,
} from "./routes";

// Loan & Advance's addresses (owner 2026-11-27: the Settlement page renamed, one page per type): the three pages, the
// old Settlement addresses (?tab=advance / ?tab=loan) and an encoded "&" going to the new ones, and the router matching
// the literal "&" in the path the way App.tsx declares it.

describe("the three addresses", () => {
  it("are the owner's, with the literal &", () => {
    expect(LOAN_ADVANCE_PAGES.map((p) => [p.label, p.path])).toEqual([
      ["Overview", "/hr/Loan&Advance"],
      ["Salary Advance", "/hr/Loan&Advance/salary-advance"],
      ["Term Loan", "/hr/Loan&Advance/term-loan"],
    ]);
    expect(loanAdvancePath("overview")).toBe("/hr/Loan&Advance");
    expect(loanAdvancePath("general")).toBe("/hr/Loan&Advance/salary-advance");
    expect(loanAdvancePath("term")).toBe("/hr/Loan&Advance/term-loan");
  });

  it("reads the page from an address, whatever its case, a / at the end, an encoded & or a query", () => {
    expect(loanAdvancePageOf("/hr/Loan&Advance")).toBe("overview");
    expect(loanAdvancePageOf("/hr/Loan&Advance/")).toBe("overview");
    expect(loanAdvancePageOf("/hr/loan&advance/salary-advance")).toBe("general");
    expect(loanAdvancePageOf("/hr/Loan%26Advance/term-loan")).toBe("term");
    expect(loanAdvancePageOf("/hr/Loan&Advance/term-loan?month=10")).toBe("term");
    expect(loanAdvancePageOf("/hr/Loan&Advance/nonsense")).toBeNull();
    expect(loanAdvancePageOf("/hr/Loan&Advances")).toBeNull();
    expect(loanAdvancePageOf("/hr/settlement")).toBeNull();
  });
});

describe("the old Settlement addresses", () => {
  it("?tab=advance is Salary Advance, ?tab=loan Term Loan, anything else the Overview", () => {
    expect(legacySettlementTarget("")).toBe("/hr/Loan&Advance");
    expect(legacySettlementTarget("?tab=overview")).toBe("/hr/Loan&Advance");
    expect(legacySettlementTarget("?tab=advance")).toBe("/hr/Loan&Advance/salary-advance");
    expect(legacySettlementTarget("?tab=loan")).toBe("/hr/Loan&Advance/term-loan");
    expect(legacySettlementTarget("?tab=nonsense")).toBe("/hr/Loan&Advance");
  });

  it("keeps every other query parameter and the #anchor; only the tab goes", () => {
    expect(legacySettlementTarget("?tab=loan&month=10&year=2026&status=all")).toBe(
      "/hr/Loan&Advance/term-loan?month=10&year=2026&status=all",
    );
    expect(legacySettlementTarget("?month=all&view=requests", "#top")).toBe(
      "/hr/Loan&Advance?month=all&view=requests#top",
    );
    expect(legacySettlementTarget("view=history&tab=advance")).toBe("/hr/Loan&Advance/salary-advance?view=history");
    expect(legacySettlementTarget("?status=pending", "#")).toBe("/hr/Loan&Advance?status=pending");
  });

  it("keeps the anchor", () => {
    expect(legacySettlementTarget("?tab=advance", "#list")).toBe("/hr/Loan&Advance/salary-advance#list");
  });
});

// ─── the router: App.tsx's routes, matched the way the browser has the address ───────────────────────────────────

const APP = readFileSync(resolve(__dirname, "../../../App.tsx"), "utf-8");

describe("App.tsx", () => {
  it("routes the prefix to the page, and sends the old and the encoded addresses on", () => {
    expect(APP).toContain('<Route path="/hr/Loan&Advance/*?">');
    expect(APP).toContain("<Route path={`${LOAN_ADVANCE_BASE_ENCODED}/*?`}>");
    expect(APP).toContain("<Route path={`${LEGACY_SETTLEMENT_BASE}/*?`}>");
    expect(APP).toContain("legacySettlementTarget(window.location.search, window.location.hash)");
    expect(APP).not.toContain('path="/hr/settlement"');
    expect(LEGACY_SETTLEMENT_BASE).toBe("/hr/settlement");
    expect(LOAN_ADVANCE_BASE_ENCODED).toBe("/hr/Loan%26Advance");
  });
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

/** What the page component sees. */
function Shown() {
  const [location] = useLocation();
  return <p data-testid="shown">page {loanAdvancePageOf(location) ?? "none"}</p>;
}

/** The same routes as App.tsx, with the page replaced by Shown (the encoded address goes on like its MovedTo). */
function Routes() {
  const [location] = useLocation();
  return (
    <Switch>
      <Route path="/hr/Loan&Advance/*?" component={Shown} />
      <Route path={`${LOAN_ADVANCE_BASE_ENCODED}/*?`}>
        <Redirect
          to={`${LOAN_ADVANCE_BASE}${location.slice(LOAN_ADVANCE_BASE_ENCODED.length)}${window.location.search}`}
          replace
        />
      </Route>
      <Route path={`${LEGACY_SETTLEMENT_BASE}/*?`}>
        <Redirect to={legacySettlementTarget(window.location.search, window.location.hash)} replace />
      </Route>
      <Route>
        <p data-testid="shown">no page</p>
      </Route>
    </Switch>
  );
}

function open(address: string) {
  window.history.replaceState(null, "", address);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Routes />));
  return document.querySelector('[data-testid="shown"]')?.textContent;
}

describe("the router", () => {
  it("matches the literal & of the three pages", () => {
    expect(open("/hr/Loan&Advance")).toBe("page overview");
    act(() => root!.unmount());
    expect(open("/hr/Loan&Advance/salary-advance")).toBe("page general");
    act(() => root!.unmount());
    expect(open("/hr/Loan&Advance/term-loan?month=10&year=2026")).toBe("page term");
    expect(window.location.pathname).toBe("/hr/Loan&Advance/term-loan");
  });

  it("sends /hr/settlement?tab=advance to Salary Advance with the rest of its query", () => {
    expect(open("/hr/settlement?tab=advance&month=10&year=2026")).toBe("page general");
    expect(window.location.pathname).toBe("/hr/Loan&Advance/salary-advance");
    expect(window.location.search).toBe("?month=10&year=2026");
    act(() => root!.unmount());
    expect(open("/hr/settlement?tab=loan")).toBe("page term");
    expect(window.location.pathname + window.location.search).toBe("/hr/Loan&Advance/term-loan");
    act(() => root!.unmount());
    expect(open("/hr/settlement")).toBe("page overview");
    expect(window.location.pathname).toBe("/hr/Loan&Advance");
  });

  it("sends a percent-encoded & to the plain address", () => {
    expect(open("/hr/Loan%26Advance/term-loan?status=all")).toBe("page term");
    expect(window.location.pathname + window.location.search).toBe("/hr/Loan&Advance/term-loan?status=all");
  });

  it("leaves look-alikes alone", () => {
    expect(open("/hr/Loan&Advances")).toBe("no page");
  });
});
