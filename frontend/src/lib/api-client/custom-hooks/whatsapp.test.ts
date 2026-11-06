import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../custom-fetch";
import {
  readWhatsAppQueue,
  useSetWhatsAppOptOut,
  whatsAppErrorMessage,
  type Paged,
  type WhatsAppEmployeeRow,
} from "./whatsapp";

// The WhatsApp Control page reads the sending queue through readWhatsAppQueue, so a partial answer (an older or a newer
// server) shows safe values instead of breaking the Overview.

describe("readWhatsAppQueue", () => {
  it("fills in every key of an empty answer with the safe reading", () => {
    expect(readWhatsAppQueue(null)).toEqual({
      engineEnabled: true,
      paused: false,
      pausedReason: "",
      inQuietHours: false,
      queued: 0,
      sentToday: 0,
      sentLastHour: 0,
      failedToday: 0,
      expiredToday: 0,
      skippedToday: 0,
      nextSendAt: null,
      limits: { minGapSeconds: 0, maxPerHour: 0, maxPerDay: 0, maxPerEmployeePerDay: 0 },
    });
    expect(readWhatsAppQueue({ queued: "7", nextSendAt: "" }).queued).toBe(0);
    expect(readWhatsAppQueue({ nextSendAt: "" }).nextSendAt).toBeNull();
  });

  it("keeps what the server sent", () => {
    const q = {
      engineEnabled: false,
      paused: true,
      pausedReason: "WhatsApp asked us to slow down",
      inQuietHours: true,
      queued: 12,
      sentToday: 42,
      sentLastHour: 8,
      failedToday: 1,
      expiredToday: 2,
      skippedToday: 3,
      nextSendAt: "2026-11-06T10:42:00+05:30",
      limits: { minGapSeconds: 30, maxPerHour: 60, maxPerDay: 200, maxPerEmployeePerDay: 3 },
    };
    expect(readWhatsAppQueue(q)).toEqual(q);
  });
});

describe("whatsAppErrorMessage", () => {
  const refusal = (body: unknown) =>
    new ApiError(new Response(JSON.stringify(body), { status: 400 }), body, { method: "PUT", url: "/x" });

  it("uses the server's own sentence", () => {
    expect(whatsAppErrorMessage(refusal({ error: "Max per hour must be between 1 and 500." }), "fallback")).toBe(
      "Max per hour must be between 1 and 500.",
    );
    expect(whatsAppErrorMessage(refusal({ detail: "Not allowed." }), "fallback")).toBe("Not allowed.");
  });

  it("falls back when the server said nothing useful", () => {
    expect(whatsAppErrorMessage(refusal({ error: "  " }), "fallback")).toBe("fallback");
    expect(whatsAppErrorMessage(refusal(null), "fallback")).toBe("fallback");
    expect(whatsAppErrorMessage(new Error("Network down"), "fallback")).toBe("Network down");
    expect(whatsAppErrorMessage("??", "fallback")).toBe("fallback");
  });
});

// ── No WhatsApp: the switch moves before the server answers, and moves back if it refuses ────────────────────────────

const row = (employeeId: number, optOut: boolean): WhatsAppEmployeeRow => ({
  employeeId,
  employeeCode: `E${employeeId}`,
  employeeName: `Employee ${employeeId}`,
  phone: "919000000001",
  department: null,
  total: 1,
  failed: 0,
  lastMessageAt: null,
  optOut,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("useSetWhatsAppOptOut", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates every cached employee list at once and rolls back on a refusal", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const answers: ((r: Response) => void)[] = [];
    const fetchStub = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
    vi.stubGlobal("fetch", fetchStub);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const all = ["/api/whatsapp-control/employees", { page: 1, pageSize: 25 }];
    const onlyOptOut = ["/api/whatsapp-control/employees", { optOut: "true", page: 1, pageSize: 1 }];
    client.setQueryData<Paged<WhatsAppEmployeeRow>>(all, {
      items: [row(7, false), row(8, false)],
      total: 2,
      page: 1,
      pageSize: 25,
    });
    client.setQueryData<Paged<WhatsAppEmployeeRow>>(onlyOptOut, { items: [], total: 0, page: 1, pageSize: 1 });
    const flags = () => client.getQueryData<Paged<WhatsAppEmployeeRow>>(all)!.items.map((r) => r.optOut);

    let hook!: ReturnType<typeof useSetWhatsAppOptOut>;
    function Probe() {
      hook = useSetWhatsAppOptOut();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
    const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    // Before the server answers, the list already shows the change.
    await act(async () => hook.mutate({ employeeId: 7, optOut: true }));
    await tick();
    expect(flags()).toEqual([true, false]);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/whatsapp-control/employees/7/opt-out");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ optOut: true });

    // The server refuses: the switch goes back.
    await act(async () => answers[0](json({ error: "Not allowed" }, 500)));
    await tick();
    expect(flags()).toEqual([false, false]);

    // A reason travels with the change when given, and a success keeps it.
    await act(async () => hook.mutate({ employeeId: 8, optOut: true, reason: "Asked at the gate" }));
    await tick();
    expect(JSON.parse(String((fetchStub.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({
      optOut: true,
      reason: "Asked at the gate",
    });
    await act(async () => answers[1](json(row(8, true))));
    await tick();
    expect(flags()).toEqual([false, true]);
    act(() => root.unmount());
    client.clear();
  });
});
