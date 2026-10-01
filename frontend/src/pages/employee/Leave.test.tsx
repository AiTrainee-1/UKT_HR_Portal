import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The employee Leave page's request-date guidance (see src/lib/request-window.ts). The page's data hooks, layout and
// toast are replaced by stubs; the form, the dialog and the request-window rule are the real ones.
const mutate = vi.fn();
const toast = vi.fn();

vi.mock("@/components/EmployeeLayout", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { employeeId: 7 } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  useListLeaveRequests: () => ({ data: [], isLoading: false }),
  useCreateLeaveRequest: () => ({ mutate, isPending: false }),
  getListLeaveRequestsQueryKey: () => ["leave"],
}));

import EmployeeLeave from "./Leave";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The first render pulls in the dialog/select libraries and takes over a second on a cold or busy machine.
vi.setConfig({ testTimeout: 20_000 });

let container: HTMLDivElement;
let root: Root;

const byTestId = <T extends HTMLElement>(id: string) => document.body.querySelector<T>(`[data-testid="${id}"]`);

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(EmployeeLeave));
  });
}

async function openDialog() {
  await act(async () => {
    byTestId("button-apply-leave")!.click();
  });
}

async function type(testId: string, value: string) {
  const el = byTestId<HTMLInputElement | HTMLTextAreaElement>(testId)!;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fill(start: string, end: string) {
  await type("input-start-date", start);
  await type("input-end-date", end);
  await type("input-reason", "Family function");
}

async function submit() {
  await act(async () => {
    byTestId("button-submit")!.click();
  });
}

const messages = () => Array.from(document.body.querySelectorAll("form p")).map((p) => p.textContent);

/** Stub "now" as a local date at 13:30 (only Date is faked, so promises and React keep working). */
const setToday = (y: number, m: number, d: number, hour = 13, minute = 30) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(y, m - 1, d, hour, minute));
};

beforeEach(() => {
  mutate.mockReset();
  toast.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("employee Leave page request window", () => {
  it("limits both date inputs to the current month and shows the hint", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();

    const start = byTestId<HTMLInputElement>("input-start-date")!;
    const end = byTestId<HTMLInputElement>("input-end-date")!;
    expect([start.min, start.max]).toEqual(["2026-10-01", "2026-10-31"]);
    expect([end.min, end.max]).toEqual(["2026-10-01", "2026-10-31"]);
    expect(byTestId("text-date-window-hint")!.textContent).toBe("Any day in October 2026");
  });

  it("raises the end date's minimum to the chosen start date", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();

    await type("input-start-date", "2026-10-20");
    expect(byTestId<HTMLInputElement>("input-end-date")!.min).toBe("2026-10-20");
    // a start before the window never lowers the end's minimum below the window
    await type("input-start-date", "2026-09-05");
    expect(byTestId<HTMLInputElement>("input-end-date")!.min).toBe("2026-10-01");
  });

  it("keeps last month open on the 1st and 2nd", async () => {
    setToday(2026, 10, 2);
    await render();
    await openDialog();

    expect(byTestId<HTMLInputElement>("input-start-date")!.min).toBe("2026-09-01");
    expect(byTestId("text-date-window-hint")!.textContent).toBe("1 September 2026 to 31 October 2026");

    await fill("2026-09-30", "2026-09-30");
    await submit();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      data: {
        type: "casual",
        startDate: "2026-09-30",
        endDate: "2026-09-30",
        reason: "Family function",
        employeeId: 7,
      },
    });
  });

  it("blocks a start outside the window inline, under the start date, without calling the API", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();

    await fill("2026-09-30", "2026-10-02");
    await submit();

    expect(mutate).not.toHaveBeenCalled();
    expect(messages()).toContain("You can only request dates in October 2026.");
    expect(document.activeElement).toBe(byTestId("input-start-date"));
  });

  it("blocks an end outside the window inline, under the end date (both ends of a range are checked)", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();

    await fill("2026-10-30", "2026-11-02");
    await submit();

    expect(mutate).not.toHaveBeenCalled();
    expect(messages()).toContain("You can only request dates in October 2026.");
    expect(document.activeElement).toBe(byTestId("input-end-date"));
  });

  it("blocks an end before the start, and a month-end range that is wholly inside the window passes", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();

    await fill("2026-10-22", "2026-10-20");
    await submit();
    expect(mutate).not.toHaveBeenCalled();
    expect(messages()).toContain("End date must be on or after start date.");

    await fill("2026-10-29", "2026-10-31");
    await submit();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("clears the date messages as soon as a date is edited", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();

    await fill("2026-10-22", "2026-10-20");
    await submit();
    expect(messages()).toContain("End date must be on or after start date.");

    await type("input-start-date", "2026-10-19");
    expect(messages()).not.toContain("End date must be on or after start date.");
  });

  it("reads the clock again at submit: a form left open past the grace period rejects last month", async () => {
    setToday(2026, 10, 2, 23, 59);
    await render();
    await openDialog();
    await fill("2026-09-30", "2026-09-30");

    // midnight passes while the dialog sits open; nothing re-renders the page
    vi.setSystemTime(new Date(2026, 9, 3, 0, 0));
    await submit();

    expect(mutate).not.toHaveBeenCalled();
    expect(messages()).toContain("You can only request dates in October 2026.");
  });

  it("reads the clock on every render: the limits follow it across a month end without remounting the page", async () => {
    setToday(2026, 10, 31, 23, 59);
    await render();
    await openDialog();

    const start = byTestId<HTMLInputElement>("input-start-date")!;
    const end = byTestId<HTMLInputElement>("input-end-date")!;
    expect([start.min, start.max, end.max]).toEqual(["2026-10-01", "2026-10-31", "2026-10-31"]);
    expect(byTestId("text-date-window-hint")!.textContent).toBe("Any day in October 2026");

    // midnight: November 1st. The page stays mounted and nothing remounts it; the next render (here a date edit) must
    // read the new clock, so the window now runs 1 October (grace) to 30 November.
    vi.setSystemTime(new Date(2026, 10, 1, 0, 0));
    await type("input-start-date", "2026-10-31");
    expect([start.min, start.max, end.max]).toEqual(["2026-10-01", "2026-11-30", "2026-11-30"]);
    expect(byTestId("text-date-window-hint")!.textContent).toBe("1 October 2026 to 30 November 2026");

    // the 3rd: the grace is over, so the window starts on 1 November
    vi.setSystemTime(new Date(2026, 10, 3, 0, 0));
    await type("input-start-date", "2026-11-04");
    expect([start.min, start.max, end.min, end.max]).toEqual(["2026-11-01", "2026-11-30", "2026-11-04", "2026-11-30"]);
    expect(byTestId("text-date-window-hint")!.textContent).toBe("Any day in November 2026");
    // it is still the same input elements: the page was never remounted
    expect(byTestId("input-start-date")).toBe(start);
  });

  it("shows the server's 400 {error} in the form (as well as the toast) and clears it on edit, close and reopen", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();
    await fill("2026-10-20", "2026-10-22");
    await submit();

    expect(mutate).toHaveBeenCalledTimes(1);
    const { onError } = mutate.mock.calls[0][1];
    await act(async () => {
      onError({ data: { error: "You can only request dates in October 2026.", code: "request_window_closed" } });
    });
    const alert = byTestId("text-form-error")!;
    expect(alert.textContent).toBe("You can only request dates in October 2026.");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(toast).toHaveBeenCalledWith({
      title: "Error",
      description: "You can only request dates in October 2026.",
      variant: "destructive",
    });

    // editing a date clears it
    await type("input-end-date", "2026-10-23");
    expect(byTestId("text-form-error")).toBeNull();

    // a failure without a body falls back to the generic text, and Cancel + reopen starts clean
    await submit();
    await act(async () => {
      mutate.mock.calls[1][1].onError(new Error("boom"));
    });
    expect(byTestId("text-form-error")!.textContent).toBe("Failed to submit leave request.");
    await act(async () => {
      byTestId("button-cancel")!.click();
    });
    await openDialog();
    expect(byTestId("text-form-error")).toBeNull();
  });

  it("clears the server's error when Submit is pressed again, even if the form's own checks stop that submit", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();
    await fill("2026-10-20", "2026-10-22");
    await submit();
    await act(async () => {
      mutate.mock.calls[0][1].onError({ data: { error: "You already have leave on those dates." } });
    });
    expect(byTestId("text-form-error")!.textContent).toBe("You already have leave on those dates.");

    // blank the reason: the zod check stops the submit before onSubmit runs, and the old server error must still go
    await type("input-reason", "");
    await submit();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(messages()).toContain("Please provide a reason");
    expect(byTestId("text-form-error")).toBeNull();
  });

  it("does not let the browser's own min/max bubble replace the form's messages", async () => {
    setToday(2026, 10, 15);
    await render();
    await openDialog();
    expect(document.body.querySelector("form")!.noValidate).toBe(true);
  });
});
