import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StaffCardBack, StaffCardFront } from "@/components/idcard/IdCardViews";
import { DEFAULT_TEMPLATE, HONOURED, drawableTemplate, honouredBy, sampleCard } from "./preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const COMPANY = { name: "UKTextiles", address: "12, Kumaran Road, Tirupur", logo: null, signature: null };

describe("ID card template preview", () => {
  it("says which places honour each option", () => {
    expect(honouredBy("textColor")).toBe("only the ID Cards page");
    expect(honouredBy("showQrOnBack")).toBe("the ID Cards page, the Employee Mobile App and the Employee Web App");
    expect(honouredBy("primaryColor")).toBe(
      "the ID Cards page, the Employee Mobile App and the picture sent by email or WhatsApp",
    );
    // Every option is honoured by the ID Cards page itself.
    expect(Object.values(HONOURED).every((row) => row[0])).toBe(true);
  });

  it("draws a half-typed colour as the default until it is a full code", () => {
    const t = drawableTemplate({ ...DEFAULT_TEMPLATE, primaryColor: "#7F0", textColor: "#334155" });
    expect(t.primaryColor).toBe(DEFAULT_TEMPLATE.primaryColor);
    expect(t.textColor).toBe("#334155");
  });

  it("feeds the unsaved template to the real card faces", () => {
    const template = { ...DEFAULT_TEMPLATE, footerText: "Valid for 2026", showQrOnBack: false, textColor: "#7f011f" };
    const card = sampleCard(template, COMPANY, false);
    const back = render(createElement(StaffCardBack, { card }));
    expect(back.textContent).toContain("Valid for 2026");
    expect(back.textContent).toContain("If found, please return to UKTextiles, 12, Kumaran Road, Tirupur.");
    expect(back.textContent).not.toContain("SCAN TO VERIFY");
    act(() => root!.render(createElement(StaffCardFront, { card })));
    const name = [...host!.querySelectorAll("p")].find((p) => p.textContent === "Priya Sharma");
    expect(name?.getAttribute("style")).toContain("color: rgb(127, 1, 31)");
  });

  it("uses a production employee on the production card", () => {
    expect(sampleCard(DEFAULT_TEMPLATE, COMPANY, true)).toMatchObject({
      code: "SAMPLE-002",
      employmentType: "production",
    });
  });
});
