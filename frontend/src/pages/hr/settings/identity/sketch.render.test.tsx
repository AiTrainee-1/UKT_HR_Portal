import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentSketch, headerLayout, type DocumentSketchProps } from "./DocumentSketch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: Partial<DocumentSketchProps> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const all: DocumentSketchProps = {
    doc: "offer_letter",
    label: "Offer letter",
    primary: "#0E4B3A",
    accent: "#C9A227",
    headingStyle: "serif",
    logo: "data:image/png;base64,AAAA",
    name: "UKTEXTILES",
    address: "12, Kumaran Road, Tirupur - 641601",
    contacts: ["www.uktextiles.example"],
    watermark: "UKTEXTILES",
    tagline: "Weaving Quality. Building Trust.",
    contactLine: "12, Kumaran Road",
    note: "This is a system-generated offer letter from the UKTextiles HR Portal.",
    ...props,
  };
  act(() => root!.render(createElement(DocumentSketch, all)));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("DocumentSketch", () => {
  it("stretches the logo into the fixed letterhead box, like the PDF does", () => {
    const el = render();
    const logo = el.querySelector('[data-sketch="logo"]')!;
    expect(logo.getAttribute("preserveAspectRatio")).toBe("none");
    expect(Number(logo.getAttribute("width"))).toBeCloseTo(73.7, 1);
    expect(Number(logo.getAttribute("height"))).toBeCloseTo(42.5, 1);
  });

  it("draws the parts it is told to, and rings the highlighted ones", () => {
    const el = render({ highlight: ["tagline", "logo"], watermark: null });
    expect(el.querySelector('[data-sketch="tagline"]')?.textContent).toBe("Weaving Quality. Building Trust.");
    expect(el.querySelector('[data-sketch="watermark"]')).toBeNull();
    const rings = [...el.querySelectorAll("[data-sketch-ring]")].map((r) => r.getAttribute("data-sketch-ring"));
    expect(rings).toEqual(["tagline", "logo"]);
  });

  it("draws the salary slip header with the month badge and the minimum wage row", () => {
    const el = render({ doc: "salary_slip", minWage: "₹700.00", highlight: ["minWage", "badge"] });
    expect(el.querySelector('[data-sketch="title"]')?.textContent).toBe("SALARY SLIP");
    expect(el.querySelector('[data-sketch="badge"]')?.textContent).toBe("July 2026");
    expect(el.querySelector('[data-sketch="minWage"]')?.textContent).toBe("₹700.00");
    expect(el.querySelectorAll("[data-sketch-ring]")).toHaveLength(2);
  });

  it("wraps a long letterhead name over lines, below the logo", () => {
    const lay = headerLayout({
      doc: "offer_letter",
      logo: "x",
      name: "UK TEXTILES PRIVATE LIMITED GARMENT EXPORTERS",
      address: "",
      headingStyle: "serif",
    });
    expect(lay.nameLines.length).toBeGreaterThan(1);
    expect(lay.name.y).toBeGreaterThan(lay.logo!.y + lay.logo!.h);
  });
});
