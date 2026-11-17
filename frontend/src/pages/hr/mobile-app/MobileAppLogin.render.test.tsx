import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { useAuth } from "@/contexts/AuthContext";
import MobileAppLogin from "../MobileAppLogin";

// Mobile App Login after 2026-11-17: its Mobile Messages tab moved to Phone Notify Control (/hr/phone-notify-control). The
// page keeps Login Status and New Version, and Login Status says in one line where the phone notifications went.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

const signedIn = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  name: "Test HR",
  isSuperAdmin: false,
  permissions,
});

/** Like the app's ProtectedRoute: the page is drawn once the login is known. */
function SignedIn({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : null;
}

const LOGINS = {
  results: [],
  summary: { total: 0, hasAccess: 0, noAccess: 0, activeNoAccess: 0, signedIn: 0 },
};

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async (permissions: Record<string, string>) => {
  page = await renderMdPage(
    () => (
      <SignedIn>
        <MobileAppLogin />
      </SignedIn>
    ),
    { "/api/auth/me": signedIn(permissions), "/api/mobile-app-logins": LOGINS } as never,
    { path: "/hr/mobile-app-login" },
  );
  return page;
};

/** The labels of the page's own tabs (the first row of pills; Login Status has filter pills of its own below). */
const pillLabels = () =>
  [...(page!.container.querySelector('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])].map((t) =>
    (t.querySelector(".ptab-label")?.textContent ?? t.textContent ?? "").trim(),
  );

describe("Mobile App Login", () => {
  it("has no Mobile Messages tab any more, and asks nothing of the phone notifications", async () => {
    await open({ mobile_app_login: "edit" });
    expect(pillLabels()).toEqual(["Login Status", "New Version"]);
    expect(page!.text()).not.toContain("Mobile Messages");
    expect(page!.requests().some((r) => r.startsWith("/api/mobile-app/messages"))).toBe(false);
  });

  it("says on Login Status where the phone notifications are now, with a link for a role that may open it", async () => {
    await open({ mobile_app_login: "edit" });
    const line = page!.container.querySelector('[data-testid="phone-notify-moved"]');
    expect(line?.textContent).toContain("Phone Notify Control");
    expect(line?.querySelector("a")?.getAttribute("href")).toBe("/hr/phone-notify-control");
  });

  it("names the page without a link for a role that may not open it", async () => {
    await open({ mobile_app_login: "edit", phone_notify_control: "hidden" });
    const line = page!.container.querySelector('[data-testid="phone-notify-moved"]');
    expect(line?.textContent).toContain("Phone Notify Control");
    expect(line?.querySelector("a")).toBeNull();
  });
});
