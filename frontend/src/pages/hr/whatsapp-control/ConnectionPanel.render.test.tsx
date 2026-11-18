import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type Fixture, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import ConnectionPanel from "./ConnectionPanel";
import { connection } from "./test-fixtures";

// Configuration -> Connection check: one answer from GET /api/whatsapp-control/connection shown as a verdict (all good, or
// the problems most important first), WAClient's state, this machine's rules, the queue, documents (set apart: a lower
// priority than text messages) and the last failure, with WAClient's raw answer folded away. Read on open and on
// "Check again" only.

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (answer: Fixture) => {
  page = await renderMdPage(
    () => <ConnectionPanel />,
    { "/api/whatsapp-control/connection": answer },
    {
      path: "/hr/whatsapp-control",
    },
  );
  return page;
};
const el = (id: string) => page!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => (el(id)?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the connection check", () => {
  it("says all good when only documents are held back, and keeps the documents note apart and secondary", async () => {
    await open(connection());
    expect(el("wa-conn-verdict")!.dataset.tone).toBe("good");
    expect(text("wa-conn-verdict")).toContain("All good: WhatsApp can send from this server, to employee 30020 only.");
    expect(el("wa-conn-problems")).toBeNull();
    // documents: a quiet note, not the headline
    expect(el("wa-conn-documents-note")!.dataset.tone).toBe("neutral");
    expect(text("wa-conn-documents-note")).toContain("Documents only");
    expect(text("wa-conn-documents-note")).toContain("BACKEND_PUBLIC_URL");
    // WAClient's state, the linked instance, the machine's limit, the queue, the last failure
    expect(el("wa-conn-state")!.dataset.state).toBe("connected");
    expect(text("wa-conn-state")).toBe("Connected");
    expect(text("wa-conn-provider")).toContain("…C042");
    expect(text("wa-conn-limited")).toContain("This machine may only message employee 30020");
    expect(text("wa-conn-queue")).toContain("Master switch");
    expect(text("wa-conn-queue")).toContain("ON");
    expect(text("wa-conn-last-failure")).toContain("Salary slip");
    expect(text("wa-conn-last-failure")).toContain("WAClient can't download documents.");
  });

  it("lists the problems most important first when something stops sending", async () => {
    await open(
      connection({
        problems: [
          "The WhatsApp number is 'disconnected' at WAClient, not connected: open app.waclient.com and link the number again (scan the QR code).",
          "The master switch is OFF (Feature Controls): no WhatsApp message is sent, codes included.",
          "Documents cannot be sent from here: the address is private.",
        ],
        provider: {
          ok: true,
          state: "disconnected",
          socketLoaded: false,
          reloginRequired: true,
          httpStatus: 200,
          raw: {},
        },
        queue: {
          engineEnabled: false,
          paused: true,
          pausedReason: "Too many failures",
          inQuietHours: false,
          queued: 4,
          sentToday: 0,
          failedToday: 3,
        },
      }),
    );
    expect(el("wa-conn-verdict")!.dataset.tone).toBe("bad");
    expect(text("wa-conn-verdict")).toContain("2 things stop WhatsApp from sending");
    const items = [...el("wa-conn-problems")!.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("'disconnected'");
    expect(items[1]).toContain("master switch is OFF");
    expect(el("wa-conn-state")!.dataset.state).toBe("disconnected");
    expect(el("wa-conn-state")!.querySelector('[data-tone="danger"]')).not.toBeNull();
    expect(text("wa-conn-provider")).toContain("Must link again");
    expect(text("wa-conn-queue")).toContain("Yes: Too many failures");
    expect(text("wa-conn-queue")).toContain("OFF");
  });

  it("shows WAClient's own error and HTTP status when it did not answer", async () => {
    await open(
      connection({
        problems: ["WAClient did not answer the status check: Invalid access token"],
        provider: { ok: false, error: "Invalid access token", httpStatus: 401, raw: { status: "error" } },
      }),
    );
    expect(text("wa-conn-provider")).toContain("No answer");
    expect(text("wa-conn-provider-error")).toContain("Invalid access token");
    expect(text("wa-conn-provider-error")).toContain("HTTP 401");
    expect(el("wa-conn-state")).toBeNull();
  });

  it("says WAClient was not asked when the keys are missing", async () => {
    await open(
      connection({
        problems: ["The WAClient keys are missing on this server: set WACLIENT_INSTANCE_ID and WACLIENT_ACCESS_TOKEN."],
        credentials: false,
        instance: null,
        provider: null,
      }),
    );
    expect(text("wa-conn-provider-missing")).toContain("keys are missing");
    expect(text("wa-conn-verdict")).toContain("One thing stops WhatsApp from sending");
    expect(el("wa-conn-raw")).toBeNull();
  });

  it("badges each WAClient state in its colour", async () => {
    for (const [state, tone, label] of [
      ["logged_out", "danger", "Logged out"],
      ["linking", "warning", "Linking"],
      ["connecting", "warning", "Connecting"],
      ["unknown", "neutral", "Unknown"],
    ] as const) {
      await open(
        connection({
          provider: { ok: true, state, socketLoaded: null, reloginRequired: null, httpStatus: 200, raw: null },
        }),
      );
      expect(el("wa-conn-state")!.querySelector("[data-tone]")!.getAttribute("data-tone"), state).toBe(tone);
      expect(text("wa-conn-state"), state).toBe(label);
      page!.unmount();
      page = undefined;
    }
  });

  it("folds WAClient's raw answer away until it is opened", async () => {
    await open(connection());
    const details = el("wa-conn-raw") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("WAClient's raw answer");
    await page!.click('[data-testid="wa-conn-raw"] summary');
    expect(details.open).toBe(true);
    expect(details.querySelector("pre")!.textContent).toContain('"connection_state": "connected"');
  });

  it("asks again only when told to", async () => {
    await open(connection());
    const asked = () => page!.requests().filter((r) => r === "/api/whatsapp-control/connection").length;
    expect(asked()).toBe(1);
    await page!.settle();
    expect(asked()).toBe(1);
    await page!.click('[data-testid="wa-conn-recheck"]');
    expect(asked()).toBe(2);
  });

  it("says so when the check itself fails", async () => {
    await open({ status: 500, body: { error: "Server error" } });
    expect(text("wa-conn-error")).toContain("Server error");
  });
});
