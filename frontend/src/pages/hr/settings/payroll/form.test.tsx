import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  numberOr,
  parseNumber,
  RANGES,
  sameValue,
  saveErrorText,
  useDraft,
  useSubTabFromAddress,
  type Draft,
} from "./form";

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

describe("parseNumber", () => {
  it("reads plain numbers and explains everything else", () => {
    expect(parseNumber(" 12.5 ", RANGES.percent)).toEqual({ value: 12.5, error: null });
    expect(parseNumber("12.", RANGES.percent).value).toBe(12);
    expect(parseNumber(".75", RANGES.percent).value).toBe(0.75);
    expect(parseNumber("12.500", RANGES.percent).value).toBe(12.5);
    expect(parseNumber("", RANGES.percent).error).toBe("Enter a number.");
    expect(parseNumber("-1", RANGES.percent).error).toBe("Must be 0 or more.");
    expect(parseNumber("1e3", RANGES.percent).error).toBe("Enter a number, using digits and at most one dot.");
    expect(parseNumber("0.755", RANGES.percent).error).toBe("Use at most 2 decimals.");
    expect(parseNumber("5.5", RANGES.payDay).error).toBe("Use a whole number.");
    expect(parseNumber("100.01", RANGES.percent).error).toBe("Must be from 0 to 100.");
    expect(parseNumber("100000000", RANGES.amount).error).toBe("Must be from 0 to 9,99,99,999.99.");
    expect(numberOr("abc", RANGES.percent, 7)).toBe(7);
  });
});

describe("sameValue", () => {
  it("treats equal numbers as equal however they are typed, and compares lists by content", () => {
    expect(sameValue("12", "12.00")).toBe(true);
    expect(sameValue("12", "12.5")).toBe(false);
    expect(sameValue("", "0")).toBe(false);
    expect(sameValue([{ a: "1" }], [{ a: "1" }])).toBe(true);
    expect(sameValue(true, false)).toBe(false);
  });
});

describe("saveErrorText", () => {
  const refused = (status: number, data: unknown) =>
    new ApiError(new Response(null, { status }), data, { method: "PUT", url: "/api/payroll-settings" });

  it("passes on the server's message, but not the bare permission code (the app explains that one itself)", () => {
    expect(saveErrorText(refused(400, { error: "Salary pay day must be a day of the month from 1 to 28." }))).toBe(
      "Salary pay day must be a day of the month from 1 to 28.",
    );
    expect(saveErrorText(refused(403, { error: "company_wide_rule", message: "Ask an administrator." }))).toBe(
      "Ask an administrator.",
    );
    expect(saveErrorText(refused(403, { error: "permission_denied" }))).toBeUndefined();
    expect(saveErrorText(new Error("network"))).toBeUndefined();
  });
});

describe("useDraft", () => {
  type Form = { rate: string; on: boolean };
  let draft: Draft<Form>;
  function Harness({ saved }: { saved: Form }) {
    draft = useDraft(saved);
    return null;
  }

  it("keeps edits on top of the saved values and follows the server for untouched keys", () => {
    act(() => root.render(<Harness saved={{ rate: "12", on: false }} />));
    expect(draft.dirty).toBe(false);
    act(() => draft.set("rate", "10"));
    expect([draft.form.rate, draft.dirty, draft.changed]).toEqual(["10", true, ["rate"]]);

    // Another section saved: the server's values change, this section's edit stays.
    act(() => root.render(<Harness saved={{ rate: "12", on: true }} />));
    expect(draft.form).toEqual({ rate: "10", on: true });

    // Typing the saved value back is not a change.
    act(() => draft.set("rate", "12.0"));
    expect(draft.dirty).toBe(false);

    act(() => draft.set("on", false));
    act(() => draft.discard());
    expect([draft.form, draft.dirty]).toEqual([{ rate: "12", on: true }, false]);
  });
});

describe("useSubTabFromAddress", () => {
  const SUB_TAB_OF = { "pay-day": "rates", "bonus-percent": "bonus" } as const;
  const opened: string[] = [];
  function Harness() {
    useSubTabFromAddress<string>(SUB_TAB_OF, (s) => opened.push(s));
    return null;
  }

  it("opens the sub-tab of the setting in the address, on arrival and on every later navigation", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    // Outside the React root: rendering replaces whatever the root's container held.
    const blocks = ["bonus-percent", "pay-day"].map((id) => {
      const block = document.createElement("section");
      block.dataset.settingId = id;
      document.body.append(block);
      return block;
    });
    onTestFinished(() => blocks.forEach((b) => b.remove()));

    window.history.replaceState(null, "", "/hr/settings?tab=payroll#bonus-percent");
    act(() => root.render(<Harness />));
    expect(opened).toEqual(["bonus"]);
    expect(scrolled).toHaveBeenCalledTimes(1);

    // The page's own search navigates with replaceState and scrolls by itself.
    window.history.replaceState(null, "", "/hr/settings?tab=payroll#pay-day");
    act(() => {
      window.dispatchEvent(new Event("replaceState"));
    });
    expect(opened).toEqual(["bonus", "rates"]);
    expect(scrolled).toHaveBeenCalledTimes(1);

    // A link inside the tab pushes the address: this hook scrolls there.
    window.history.pushState(null, "", "/hr/settings?tab=payroll#bonus-percent");
    act(() => {
      window.dispatchEvent(new Event("pushState"));
    });
    expect(opened).toEqual(["bonus", "rates", "bonus"]);
    expect(scrolled).toHaveBeenCalledTimes(2);

    window.history.replaceState(null, "", "/hr/settings?tab=payroll#unknown");
    act(() => {
      window.dispatchEvent(new Event("replaceState"));
    });
    expect(opened).toEqual(["bonus", "rates", "bonus"]);
  });
});
