import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast }));

import { useMdHrLocation } from "./embed";

type Go = ReturnType<typeof useMdHrLocation>[1];

function mount() {
  const seen: { path: string; go: Go }[] = [];
  function Probe() {
    const [path, go] = useMdHrLocation();
    seen.push({ path, go });
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return { latest: () => seen[seen.length - 1], unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  toast.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("useMdHrLocation", () => {
  it("shows the pages the address in the bar as the HR address they were written for", () => {
    window.history.replaceState(null, "", "/md/employees/5");
    const view = mount();
    expect(view.latest().path).toBe("/hr/employees/5");
    view.unmount();
  });

  it("takes the browser to the MD address when a page navigates to an HR one", () => {
    window.history.replaceState(null, "", "/md/employees");
    const view = mount();
    act(() => view.latest().go("/hr/leave?month=10"));
    expect(window.location.pathname + window.location.search).toBe("/md/leave?month=10");
    expect(toast).not.toHaveBeenCalled();
    view.unmount();
  });

  it("goes nowhere and says so when a page links to something only the Admin may open", () => {
    window.history.replaceState(null, "", "/md/requests");
    const view = mount();
    act(() => view.latest().go("/hr/user-management"));
    expect(window.location.pathname).toBe("/md/requests");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "Available only to the Admin" });
    expect(String(toast.mock.calls[0][0].description)).toContain("User Management");
    act(() => view.latest().go("/hr/some-new-page"));
    expect(window.location.pathname).toBe("/md/requests");
    expect(toast).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
