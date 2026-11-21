import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drillClick } from "./drill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("drillClick", () => {
  it("opens on a click on the card, but not from its own buttons or a popover it opened", () => {
    const open = vi.fn();
    act(() =>
      root.render(
        <div role="button" tabIndex={0} onClick={drillClick(open)} data-testid="card">
          <span data-testid="value">12</span>
          <button type="button" data-testid="explain">
            ?
          </button>
          {createPortal(<p data-testid="popover">How it is calculated</p>, document.body)}
        </div>,
      ),
    );
    const click = (id: string) =>
      act(() => {
        document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
      });
    click("value");
    expect(open).toHaveBeenCalledTimes(1);
    click("explain");
    click("popover");
    expect(open).toHaveBeenCalledTimes(1);
    click("card");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("still opens when called without an event (the keyboard path)", () => {
    const open = vi.fn();
    drillClick(open)();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
