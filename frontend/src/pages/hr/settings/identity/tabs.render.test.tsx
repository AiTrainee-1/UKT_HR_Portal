import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { CONTACT_FORM_KEYS } from "@/lib/support-contact";
import CompanyTab from "../CompanyTab";
import { COMPANY_SETTINGS } from "../CompanyTab.meta";
import HrContactTab from "../HrContactTab";
import { HR_CONTACT_SETTINGS } from "../HrContactTab.meta";
import SalarySlipTab from "../SalarySlipTab";
import { SALARY_SLIP_SETTINGS } from "../SalarySlipTab.meta";
import IdCardTab from "../IdCardTab";
import { ID_CARD_SETTINGS } from "../IdCardTab.meta";
import DocumentsTab from "../DocumentsTab";
import { DOCUMENTS_SETTINGS } from "../DocumentsTab.meta";
import type { SettingMeta } from "../kit/catalog";

// jsdom render checks of the five identity tabs (Company, HR Contact, Salary Slip, ID Card, Company Documents) with a
// fake server: every setting the search knows about is drawn under the same title, the Save buttons keep their old
// names, a save carries exactly the tab's own keys (a removed image reaches the server as null), and a bad value is
// stopped before anything is sent. The pages themselves are covered by e2e/settings.spec.ts and hr-contact.spec.ts.

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));
// The ID card back draws a QR code with a canvas, which jsdom has not got.
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,QR" } }));

const HR = { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} };

const SETTINGS: Record<string, unknown> = {
  companyName: "UKTextiles",
  companyLogo: null,
  companyAddress: "12, Kumaran Road, Tirupur - 641601",
  companyPhone: "0421 2234500",
  companyEmail: "hr@uktextiles.in",
  companyWebsite: "www.uktextiles.in",
  companyGstin: "",
  companyTagline: "",
  companyPan: "AAAAA0000A",
  companyRegistration: "",
  slipCompanyName: "UK TEXTILES - H.O",
  slipCompanyAddress: "TIRUPUR",
  minWageRate: 0,
  signatureImage: "data:image/png;base64,SIG",
  authorizedSignature: null,
  ...Object.fromEntries(CONTACT_FORM_KEYS.map((k) => [k, ""])),
  companyWideRulesEditable: true,
};

const look = (docType: string) => ({
  docType,
  primaryColor: "#0E4B3A",
  accentColor: "#C9A227",
  headingStyle: "serif",
  showWatermark: true,
  footerTagline: "Weaving Quality. Building Trust.",
  logoOverride: "",
  updatedAt: null,
});

const IDCARD = {
  primaryColor: "#006496",
  secondaryColor: "#4FB8F0",
  textColor: "#0f172a",
  fontFamily: "Hanken Grotesk",
  backgroundStyle: "gradient",
  logoPosition: "left",
  cornerStyle: "rounded",
  showQrOnBack: true,
  footerText: "",
  updatedAt: null,
};

type Put = { path: string; body: Record<string, unknown> };

let page: RenderedPage | undefined;
let puts: Put[];

beforeEach(() => {
  puts = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

/** A fake row: GET answers the current value, PUT records the body, merges it and answers the result. */
function row(path: string, initial: Record<string, unknown>) {
  let current = { ...initial };
  return {
    [path]: (_params: URLSearchParams, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push({ path, body });
        current = { ...current, ...body };
      }
      return current;
    },
  };
}

async function open(Tab: () => ReactElement, settings: Record<string, unknown> = SETTINGS) {
  page = await renderMdPage(
    Tab,
    {
      "/api/auth/me": HR,
      ...row("/api/payroll-settings", settings),
      ...row("/api/idcard-settings", IDCARD),
      ...row("/api/document-settings/offer_letter", look("offer_letter")),
      ...row("/api/document-settings/experience_letter", look("experience_letter")),
      ...row("/api/document-settings/salary_slip", look("salary_slip")),
      ...row("/api/document-settings/resignation_letter", look("resignation_letter")),
    },
    { path: "/hr/settings" },
  );
  return page;
}

const button = (name: string) =>
  [...page!.container.querySelectorAll("button")].find(
    (b) => b.textContent?.replace(/\s+/g, " ").trim() === name || b.getAttribute("aria-label") === name,
  );

async function press(name: string) {
  const b = button(name);
  expect(b, `button "${name}"`).toBeDefined();
  expect(b!.disabled, `"${name}" is enabled`).toBe(false);
  await act(async () => {
    b!.click();
  });
  await page!.settle();
}

/** Every entry of the tab's meta list is drawn as a block with the same title and purpose, and nothing else is. */
function expectBlocksToMatch(metas: SettingMeta[]) {
  for (const meta of metas) {
    const block = page!.container.querySelector(`[data-setting-id="${meta.id}"]`);
    expect(block, meta.id).not.toBeNull();
    expect(block!.querySelector("h4")!.textContent, meta.id).toBe(meta.title);
    expect(block!.querySelector('[data-testid="setting-purpose"]')!.textContent, meta.id).toBe(meta.purpose);
  }
  expect(page!.container.querySelectorAll("[data-setting-id]")).toHaveLength(metas.length);
}

const saveBar = () => page!.container.querySelector('[data-testid="save-bar"]')!;

describe("Settings -> Company", () => {
  it("draws every setting the search knows about, and keeps PAN and Registration out of view", async () => {
    await open(() => <CompanyTab />);
    expectBlocksToMatch(COMPANY_SETTINGS);
    expect(page!.container.querySelector('[data-testid="input-companyPan"]')).toBeNull();
    expect(page!.container.querySelector('[data-testid="company-retired-fields"]')!.textContent).toContain(
      "PAN AAAAA0000A",
    );
    expect(button("Save Company Settings")!.disabled).toBe(true);
    expect(saveBar().getAttribute("data-dirty")).toBe("false");
  });

  it("saves the company's own keys only, the dead ones passed through unchanged and the logo as null", async () => {
    await open(() => <CompanyTab />);
    await page!.type('[data-testid="input-companyName"]', "E2E Textiles");
    expect(saveBar().getAttribute("data-dirty")).toBe("true");
    expect(page!.container.querySelector('[data-testid="company-overview"]')!.textContent).toContain("E2E Textiles");
    await press("Save Company Settings");
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe("/api/payroll-settings");
    expect(Object.keys(puts[0].body).sort()).toEqual(
      [
        "companyAddress",
        "companyEmail",
        "companyGstin",
        "companyLogo",
        "companyName",
        "companyPan",
        "companyPhone",
        "companyRegistration",
        "companyTagline",
        "companyWebsite",
      ].sort(),
    );
    expect(puts[0].body).toMatchObject({ companyName: "E2E Textiles", companyLogo: null, companyPan: "AAAAA0000A" });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Company settings saved" }));
    expect(saveBar().getAttribute("data-dirty")).toBe("false");
  });

  it("stops a bad email address before anything is sent", async () => {
    await open(() => <CompanyTab />);
    await page!.type('[data-testid="input-companyEmail"]', "not-an-address");
    expect(page!.container.querySelector('[role="alert"]')!.textContent).toContain("Type one email address");
    expect(button("Save Company Settings")!.disabled).toBe(true);
    expect(puts).toEqual([]);
  });
});

describe("Settings -> HR Contact", () => {
  it("draws every setting the search knows about and sends all eleven contact keys, nothing else", async () => {
    await open(() => <HrContactTab />);
    expectBlocksToMatch(HR_CONTACT_SETTINGS);
    expect(button("Save HR Contact")!.disabled).toBe(true);
    await page!.type('[data-testid="input-hrContactPhone"]', "0421 430 0800");
    expect(page!.container.querySelector('[data-testid="hr-contact-preview"]')!.textContent).toContain("0421 430 0800");
    await press("Save HR Contact");
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0].body).sort()).toEqual([...CONTACT_FORM_KEYS].sort());
    expect(puts[0].body.hrContactPhone).toBe("0421 430 0800");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "HR contact details saved" }));
  });
});

describe("Settings -> Salary Slip", () => {
  it("draws every setting the search knows about, shows the logo read-only and sends a removed signature as null", async () => {
    await open(() => <SalarySlipTab />);
    expectBlocksToMatch(SALARY_SLIP_SETTINGS);
    // The logo is edited on the Company tab only: here it is shown with a link there, and never sent.
    expect(page!.container.querySelector('[data-testid="input-companyLogo"]')).toBeNull();
    expect(page!.text()).toContain("No company logo saved");
    const link = [...page!.container.querySelectorAll("a")].find((a) => a.textContent?.includes("Company tab"));
    expect(link?.getAttribute("href")).toBe("/hr/settings?tab=company");

    expect(button("Save Salary Slip Settings")!.disabled).toBe(true);
    await press("Remove signature");
    expect(saveBar().getAttribute("data-dirty")).toBe("true");
    await press("Save Salary Slip Settings");
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0].body).sort()).toEqual(
      ["authorizedSignature", "minWageRate", "signatureImage", "slipCompanyAddress", "slipCompanyName"].sort(),
    );
    expect(puts[0].body).toMatchObject({ signatureImage: null, authorizedSignature: null, minWageRate: 0 });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Salary Slip settings saved" }));
  });

  it("stops a negative minimum wage before anything is sent, and works the compliance example out live", async () => {
    await open(() => <SalarySlipTab />);
    expect(page!.container.querySelector('[data-testid="min-wage-unset"]')).not.toBeNull();
    await page!.type('[data-testid="input-minWageRate"]', "700");
    const cases = page!.container.querySelectorAll('[data-testid="min-wage-case"]');
    expect(cases).toHaveLength(3);
    expect(cases[0].textContent).toContain("Below minimum, ₹200.00 short");
    await page!.type('[data-testid="input-minWageRate"]', "-5");
    expect(page!.container.querySelector('[role="alert"]')!.textContent).toContain("cannot be negative");
    expect(button("Save Salary Slip Settings")!.disabled).toBe(true);
    expect(puts).toEqual([]);
  });
});

describe("Settings -> ID Card", () => {
  it("draws every setting the search knows about, the card itself and where each option is used", async () => {
    await open(() => <IdCardTab />);
    expectBlocksToMatch(ID_CARD_SETTINGS);
    expect(page!.container.querySelector('[data-testid="idcard-faces"]')!.textContent).toContain("Priya Sharma");
    expect(page!.container.querySelector('[data-testid="idcard-honoured"]')!.textContent).toContain(
      "Where each option is used",
    );
    expect(button("Save ID Card Template")!.disabled).toBe(true);
  });

  it("sends all nine template values with the footer trimmed, and draws the typed footer on the card", async () => {
    await open(() => <IdCardTab />);
    await page!.type('[data-testid="input-idcard-footer"]', " Valid for 2026 ");
    expect(page!.container.querySelector('[data-testid="idcard-faces"]')!.textContent).toContain("Valid for 2026");
    await press("Save ID Card Template");
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe("/api/idcard-settings");
    expect(Object.keys(puts[0].body).sort()).toEqual(
      [
        "primaryColor",
        "secondaryColor",
        "textColor",
        "fontFamily",
        "backgroundStyle",
        "logoPosition",
        "cornerStyle",
        "showQrOnBack",
        "footerText",
      ].sort(),
    );
    expect(puts[0].body.footerText).toBe("Valid for 2026");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "ID card template saved" }));
  });
});

describe("Settings -> Company Documents", () => {
  it("draws the six settings of the picked document only, with that document's own Save button", async () => {
    await open(() => <DocumentsTab />);
    expectBlocksToMatch(DOCUMENTS_SETTINGS);
    const saves = [...page!.container.querySelectorAll("button")]
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => t.startsWith("Save "));
    expect(saves).toEqual(["Save Offer Letter Settings"]);

    await page!.click('[data-testid="document-pick-salary_slip"]');
    expectBlocksToMatch(DOCUMENTS_SETTINGS);
    expect(page!.container.querySelector('[data-testid="document-card-active"]')!.textContent).toContain(
      "2-slips-per-page print",
    );
    expect(button("Save Salary Slip Settings")).toBeDefined();
    expect(button("Save Offer Letter Settings")).toBeUndefined();
  });

  it("refuses a footer tagline that runs off the page, then saves a fitting one to that document's own row", async () => {
    await open(() => <DocumentsTab />);
    await page!.type('[data-testid="input-tagline-offer_letter"]', "Weaving Quality. ".repeat(9));
    expect(page!.container.querySelector('[data-testid="tagline-fit-offer_letter"]')!.textContent).toContain(
      "runs off the page",
    );
    expect(button("Save Offer Letter Settings")!.disabled).toBe(true);
    expect(puts).toEqual([]);

    await page!.type('[data-testid="input-tagline-offer_letter"]', "Quality first.");
    await press("Save Offer Letter Settings");
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe("/api/document-settings/offer_letter");
    expect(Object.keys(puts[0].body).sort()).toEqual(
      ["accentColor", "footerTagline", "headingStyle", "logoOverride", "primaryColor", "showWatermark"].sort(),
    );
    expect(puts[0].body.footerTagline).toBe("Quality first.");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Offer Letter settings saved" }));
  });
});
