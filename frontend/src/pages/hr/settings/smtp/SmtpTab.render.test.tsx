import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import SmtpTab from "../SmtpTab";
import { SMTP_SETTINGS } from "../SmtpTab.meta";

// jsdom render checks of the SMTP / Email tab with a fake server: the saved App Password is never put back in a box,
// a save carries only what changed (no password unless a new one is typed), bad values are stopped before the request,
// and the "saved" message says what will really happen. (The page itself is covered by e2e/settings.spec.ts.)

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }), toast }));

const HR = { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} };

const SAVED = {
  companyName: "UK Textiles",
  companyLogo: null,
  slipCompanyName: "",
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpUsername: "hr.uktex@gmail.com",
  smtpPasswordSet: true,
  smtpFromEmail: "",
  smtpFromName: "UKTextiles HR",
  companyWideRulesEditable: true,
};

const gmailStatus = (sendingAllowedHere: boolean, emailsEnabled: boolean) => ({
  groups: [],
  timings: [],
  updatedAt: null,
  features: [{ key: "emailsEnabled", label: "Send emails", description: "", group: "master", enabled: emailsEnabled }],
  config: { sendingAllowedHere },
});

let page: RenderedPage | undefined;
let puts: Record<string, unknown>[];

beforeEach(() => {
  puts = [];
  toast.mockClear();
});
afterEach(() => {
  page?.unmount();
  page = undefined;
});

async function open({
  saved = SAVED,
  me = HR,
  gmail = gmailStatus(true, true) as unknown,
}: { saved?: Record<string, unknown>; me?: Record<string, unknown>; gmail?: unknown } = {}) {
  let current = { ...saved };
  page = await renderMdPage(
    () => <SmtpTab />,
    {
      "/api/auth/me": me,
      "/api/gmail-control/settings": gmail as never,
      "/api/payroll-settings": (_params, init) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(body);
          const { smtpPassword, ...rest } = body;
          current = { ...current, ...rest, smtpPasswordSet: Boolean(smtpPassword) || Boolean(current.smtpPasswordSet) };
        }
        return current;
      },
    },
    { path: "/hr/settings?tab=smtp" },
  );
  return page;
}

const input = (id: string) => page!.container.querySelector<HTMLInputElement>(`#${id}`)!;
const button = (name: string) =>
  [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(name))!;

async function press(name: string) {
  await act(async () => {
    button(name).click();
  });
  await page!.settle();
}

describe("SMTP / Email tab", () => {
  it("never puts the saved App Password back in a box, and says one is saved", async () => {
    await open();
    expect(input("smtp-host-input").value).toBe("smtp.gmail.com");
    expect(input("smtp-port-input").value).toBe("587");
    expect(input("smtp-password-input").value).toBe("");
    expect(input("smtp-password-input").type).toBe("password");
    expect(page!.text()).toContain("Password saved - type a new one to replace it");
    expect(button("Save SMTP Settings").disabled).toBe(true);
  });

  it("saves only the field that changed, without the password, and says what happens next", async () => {
    await open({ gmail: gmailStatus(false, true) });
    await page!.type("#smtp-host-input", "smtp.e2e.example");
    expect(button("Save SMTP Settings").disabled).toBe(false);
    await press("Save SMTP Settings");

    expect(puts).toEqual([{ smtpHost: "smtp.e2e.example" }]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "SMTP settings saved",
        description: expect.stringContaining("development setup"),
      }),
    );
    expect(input("smtp-host-input").value).toBe("smtp.e2e.example");
    expect(button("Save SMTP Settings").disabled).toBe(true);
  });

  it("sends a new App Password only when one is typed", async () => {
    await open();
    await page!.type("#smtp-password-input", "abcd efgh ijkl mnop");
    await press("Save SMTP Settings");
    expect(puts).toEqual([{ smtpPassword: "abcd efgh ijkl mnop" }]);
    expect(input("smtp-password-input").value).toBe("");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("The next email goes out through this account") }),
    );
  });

  it("stops a port or host the server would refuse before anything is sent", async () => {
    await open();
    await page!.type("#smtp-port-input", "0");
    expect(page!.text()).toContain("SMTP port must be a number from 1 to 65535");
    expect(button("Save SMTP Settings").disabled).toBe(true);
    await page!.type("#smtp-port-input", "465");
    await page!.type("#smtp-host-input", "https://smtp.gmail.com");
    expect(page!.text()).toContain("Just the server name");
    expect(button("Save SMTP Settings").disabled).toBe(true);
    expect(puts).toEqual([]);
  });

  it("draws the From line live from the boxes", async () => {
    await open();
    const header = () => page!.container.querySelector('[data-testid="smtp-preview-header"]')!.textContent;
    expect(header()).toBe("From: UKTextiles HR <hr.uktex@gmail.com>");
    await page!.type("#smtp-from-email-input", "hr@uktextiles.in");
    await page!.type("#smtp-from-name-input", "U.K. Textiles HR");
    expect(header()).toBe('From: "U.K. Textiles HR" <hr@uktextiles.in>');
    expect(page!.text()).toContain('"Send mail as"');
  });

  it("tells a branch login that its save is the branch's own account", async () => {
    await open({ saved: { ...SAVED, companyWideRulesEditable: false } });
    expect(page!.container.querySelector('[data-testid="smtp-branch-notice"]')).not.toBeNull();
    await page!.type("#smtp-from-name-input", "North HR");
    await press("Save SMTP Settings");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/^Saved for your branch only/) }),
    );
  });

  it("does not ask Gmail Control for a role that cannot open it, and says so", async () => {
    await open({ me: { ...HR, isSuperAdmin: false, permissions: { settings: "edit", gmail_control: "hidden" } } });
    expect(page!.requests().some((r) => r.startsWith("/api/gmail-control"))).toBe(false);
    expect(page!.text()).toContain("Your role cannot open Gmail Control");
    await page!.type("#smtp-from-name-input", "Acme HR");
    await press("Save SMTP Settings");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("as long as Gmail Control's switches allow it") }),
    );
  });

  it("says when nothing can be sent yet", async () => {
    await open({ saved: { ...SAVED, smtpUsername: "", smtpPasswordSet: false } });
    expect(page!.text()).toContain("No App Password saved");
    expect(page!.container.querySelector('[data-testid="smtp-readiness-result"]')!.textContent).toContain(
      "every email is refused until the username and App Password are saved",
    );
  });

  it("draws every setting the search knows about, under the same title", async () => {
    await open();
    for (const meta of SMTP_SETTINGS) {
      const block = page!.container.querySelector(`[data-setting-id="${meta.id}"]`);
      expect(block, meta.id).not.toBeNull();
      expect(block!.querySelector("h4")!.textContent).toBe(meta.title);
      expect(block!.querySelector('[data-testid="setting-purpose"]')!.textContent).toBe(meta.purpose);
    }
  });
});
