import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { addressView, CLASS_VIEWS, useAddressView, writeAddressView, type ClassView } from "./view";

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
  window.history.replaceState(null, "", "/");
});

const VIEW_OF: Record<string, ClassView> = { "late-window": "staff", "prod-late-switch": "production" };

describe("the page named in the address", () => {
  it("reads ?view= when it is one of the pages, and nothing else", () => {
    window.history.replaceState(null, "", "/hr/settings?tab=late_detection&view=production");
    expect(addressView(CLASS_VIEWS)).toBe("production");
    window.history.replaceState(null, "", "/hr/settings?tab=late_detection&view=nonsense");
    expect(addressView(CLASS_VIEWS)).toBeNull();
    window.history.replaceState(null, "", "/hr/settings?tab=late_detection");
    expect(addressView(CLASS_VIEWS)).toBeNull();
  });

  it("writes the page into the address, keeps the tab, drops the setting and adds no history entry", () => {
    window.history.replaceState(null, "", "/hr/settings?tab=attendance#late-window");
    const before = window.history.length;
    writeAddressView("production");
    expect(window.location.pathname + window.location.search).toBe("/hr/settings?tab=attendance&view=production");
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(before);
    writeAddressView("staff");
    expect(window.location.search).toBe("?tab=attendance&view=staff");
  });
});

describe("useAddressView", () => {
  let latest: { view: ClassView; choose: (next: ClassView) => void };
  function Harness({ fallback = "staff" as ClassView }: { fallback?: ClassView }) {
    const [view, choose] = useAddressView(CLASS_VIEWS, fallback, VIEW_OF);
    latest = { view, choose };
    return null;
  }
  const render = (fallback?: ClassView) => act(() => root.render(<Harness fallback={fallback} />));

  it("starts on the fallback, the page the address asks for, or the page of a setting named in it (the setting first)", () => {
    render();
    expect(latest.view).toBe("staff");
    act(() => root.unmount());
    root = createRoot(host);
    render("production");
    expect(latest.view).toBe("production");
    act(() => root.unmount());
    root = createRoot(host);

    window.history.replaceState(null, "", "/hr/settings?tab=late_detection&view=production");
    render();
    expect(latest.view).toBe("production");
    act(() => root.unmount());
    root = createRoot(host);

    window.history.replaceState(null, "", "/hr/settings?tab=late_detection&view=production#late-window");
    render();
    expect(latest.view).toBe("staff");
  });

  it("choosing a page opens it and writes it into the address", () => {
    render();
    act(() => latest.choose("production"));
    expect(latest.view).toBe("production");
    expect(window.location.search).toContain("view=production");
    act(() => latest.choose("staff"));
    expect(latest.view).toBe("staff");
    expect(window.location.search).toContain("view=staff");
  });

  it("follows the address: a link to a setting opens its page and scrolls to it, a search (replaceState) only opens it", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const block = document.createElement("section");
    block.dataset.settingId = "prod-late-switch";
    document.body.append(block);
    onTestFinished(() => block.remove());

    render();
    expect(latest.view).toBe("staff");
    window.history.pushState(null, "", "/hr/settings?tab=late_detection#prod-late-switch");
    act(() => {
      window.dispatchEvent(new Event("pushState"));
    });
    expect(latest.view).toBe("production");
    expect(scrolled).toHaveBeenCalledTimes(1);

    window.history.replaceState(null, "", "/hr/settings?tab=late_detection#late-window");
    act(() => {
      window.dispatchEvent(new Event("replaceState"));
    });
    expect(latest.view).toBe("staff");
    expect(scrolled).toHaveBeenCalledTimes(1);

    // an address with only ?view= changes the page too, and an unknown setting changes nothing
    window.history.pushState(null, "", "/hr/settings?tab=late_detection&view=production");
    act(() => {
      window.dispatchEvent(new Event("pushState"));
    });
    expect(latest.view).toBe("production");
    window.history.pushState(null, "", "/hr/settings?tab=late_detection#unknown");
    act(() => {
      window.dispatchEvent(new Event("pushState"));
    });
    expect(latest.view).toBe("production");
  });
});
