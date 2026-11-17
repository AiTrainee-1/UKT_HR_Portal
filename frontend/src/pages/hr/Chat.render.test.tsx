import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Chat from "./Chat";

// The HR Company Chat in jsdom, with a fake server behind customFetch: "Send to all branches" is offered only to a viewer
// with more than one company chat, sends allBranches: true only when ticked, says how many other chats got the message,
// and is unticked afterwards.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

type Channel = { id: number; type: "company" | "department"; name: string; branchId: number | null };
const NO_BRANCH: Channel = { id: 1, type: "company", name: "Company (no branch)", branchId: null };
const HEAD_OFFICE: Channel = { id: 2, type: "company", name: "Company - Head Office", branchId: 5 };
const UNIT1: Channel = { id: 3, type: "company", name: "Company - Unit1", branchId: 6 };

let channels: Channel[] = [];
let posts: { path: string; body: Record<string, unknown> }[] = [];

function install(list: Channel[]) {
  channels = list;
  posts = [];
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.split("?")[0];
    if (method === "GET" && path === "/api/chat/channels") return channels;
    if (method === "GET" && /^\/api\/chat\/channels\/\d+\/messages$/.test(path)) return [];
    if (method === "POST" && /^\/api\/chat\/channels\/\d+\/messages$/.test(path)) {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      posts.push({ path, body });
      return {
        id: 100 + posts.length,
        senderId: null,
        senderName: "HR",
        isHr: true,
        text: body.text,
        replyTo: null,
        reactions: [],
        createdAt: "2026-11-17T10:00:00Z",
        report: null,
        ...(body.allBranches ? { alsoPostedIn: channels.length - 1 } : {}),
      };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(8);
  }
}
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(10);
};
async function type(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Type a message…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(10);
}
const sendButton = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === "Send");

async function open() {
  window.history.replaceState(null, "", "/hr/chat");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Chat))));
  await waitFor(() => !!document.body.querySelector('input[placeholder="Type a message…"]:not([disabled])'), "the chat");
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

describe("Send to all branches", () => {
  it("is not offered to a viewer with one company chat, and a message goes to that chat only", async () => {
    install([HEAD_OFFICE]);
    await open();
    expect(q("chat-all-branches")).toBeNull();
    await type("Hello");
    await click(sendButton());
    await waitFor(() => posts.length === 1, "the post");
    expect(posts[0]).toEqual({ path: "/api/chat/channels/2/messages", body: { text: "Hello" } });
  });

  it("is offered with every branch's company chat, and sends allBranches only when ticked", async () => {
    install([NO_BRANCH, HEAD_OFFICE, UNIT1]);
    await open();
    expect(text(q("chat-all-branches"))).toContain("every branch's company chat");
    const box = q("chat-all-branches-box") as HTMLInputElement;
    expect(box.checked).toBe(false);

    // not ticked: an ordinary message
    await type("Only here");
    await click(sendButton());
    await waitFor(() => posts.length === 1, "the first post");
    expect(posts[0].body).toEqual({ text: "Only here" });
    expect(q("chat-also-posted")).toBeNull();

    // ticked: every company chat, the count said, and the box unticked again
    await click(box);
    expect((q("chat-all-branches-box") as HTMLInputElement).checked).toBe(true);
    await type("Holiday tomorrow");
    await click(sendButton());
    await waitFor(() => posts.length === 2, "the second post");
    expect(posts[1]).toEqual({
      path: "/api/chat/channels/1/messages",
      body: { text: "Holiday tomorrow", allBranches: true },
    });
    await waitFor(() => !!q("chat-also-posted"), "the note");
    expect(text(q("chat-also-posted"))).toBe("Also posted in 2 other company chats");
    expect((q("chat-all-branches-box") as HTMLInputElement).checked).toBe(false);
  });

  it("is still offered on another branch's chat picked from the switcher", async () => {
    install([NO_BRANCH, HEAD_OFFICE]);
    await open();
    await click(q("chat-channel-2"));
    expect(q("chat-channel-2")?.getAttribute("aria-selected")).toBe("true");
    expect(q("chat-all-branches")).not.toBeNull();
    await click(q("chat-all-branches-box"));
    await type("From Head Office");
    await click(sendButton());
    await waitFor(() => posts.length === 1, "the post");
    expect(posts[0]).toEqual({
      path: "/api/chat/channels/2/messages",
      body: { text: "From Head Office", allBranches: true },
    });
    await waitFor(() => !!q("chat-also-posted"), "the note");
    expect(text(q("chat-also-posted"))).toBe("Also posted in 1 other company chat");
  });
});
