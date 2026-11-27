import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch, useLocation, useSearch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import LegacySettlementRedirect from "./LegacyRedirect";

function Where() {
  const [path] = useLocation();
  const search = useSearch();
  return <p>{`${path}${search ? `?${search}` : ""}`}</p>;
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function visit(address: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const memory = memoryLocation({ path: address, record: true });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Router hook={memory.hook}>
        <Switch>
          <Route path="/md/settlement">
            <LegacySettlementRedirect />
          </Route>
          <Route>
            <Where />
          </Route>
        </Switch>
      </Router>,
    );
  });
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { shown: container.textContent, history: memory.history ?? [] };
}

describe("the old /md/settlement address", () => {
  it("goes to /md/loan-advance, replacing the history entry", async () => {
    const { shown, history } = await visit("/md/settlement");
    expect(shown).toBe("/md/loan-advance");
    expect(history).toEqual(["/md/loan-advance"]);
  });

  it("keeps the query (month, type, batch, tab)", async () => {
    const { shown } = await visit("/md/settlement?month=2026-10&type=term&batch=4&view=history");
    expect(shown).toBe("/md/loan-advance?month=2026-10&type=term&batch=4&view=history");
  });
});
