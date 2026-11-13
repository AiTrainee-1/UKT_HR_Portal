import { useEffect, useRef, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { watchMutatingControls } from "@/lib/view-only-lock";

/**
 * Hiding and locking the parts of a page (tabs, sub-tabs, sections, buttons) by their own permission keys
 * (lib/permission-modules.ts, Account Management -> Roles & Permissions). The route guard and HrLayout already handle a
 * part with an address of its own; these are for the parts that live inside one address (a ?tab=, a React state, a
 * section of the page). A key with no setting of its own follows its page, so nothing changes for a role that never set
 * one. The server refuses what it can on its own (permission-inventory.md); these only keep the screen honest.
 */

/** The signed-in login's level on one key (Super Admin and non-HR logins: edit). */
export function useLevel(): (key: string) => PermissionLevel {
  const { user } = useAuth();
  return (key: string) => permissionLevel(user, key);
}

/** The items whose key the login may see, in order (an item without a key always stays). */
export function visibleItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
  level: (key: string) => PermissionLevel,
): T[] {
  return items.filter((item) => {
    const key = keyOf(item);
    return !key || level(key) !== "hidden";
  });
}

/** The tab to show: the one asked for when the login may see it, else the first it may see (else the one asked). */
export function pickVisible<T extends string>(asked: T, visible: readonly T[]): T {
  return visible.includes(asked) ? asked : (visible[0] ?? asked);
}

/**
 * While `active` (a tab the login may only VIEW is open on a page it may edit), every button that changes something is
 * locked, the same way HrLayout locks a View-only page (portaled dialogs included). Only the open tab is mounted, so it
 * locks that tab's controls and the page's own header buttons (those stay locked until the page is opened again: the
 * cautious side).
 */
export function useViewOnlyLock(active: boolean, ...deps: unknown[]): void {
  useEffect(() => {
    if (!active) return;
    return watchMutatingControls(document.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
}

/** The amber note above a View-only tab (the page-wide one is HrLayout's). */
export function ViewOnlyTabNote({ show, testId }: { show: boolean; testId?: string }) {
  if (!show) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold"
      style={{
        background: "rgba(245,158,11,0.08)",
        color: "#b45309",
        boxShadow: "inset 3px 3px 8px rgba(245,158,11,0.06), inset -3px -3px 8px rgba(255,255,255,0.9)",
      }}
      data-testid={testId ?? "tab-view-only"}
    >
      <Eye size={15} strokeWidth={2} />
      View only: browse and inspect freely, changes can&apos;t be saved.
    </div>
  );
}

/**
 * Shows its children only when the login may see `k`. When the login may only VIEW it, the buttons inside that change
 * something are locked (a container lock: dialogs it opens are covered by their trigger being locked).
 */
export function Gate({ k, children }: { k: string; children: ReactNode }) {
  const level = useLevel()(k);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (level !== "view" || !ref.current) return;
    return watchMutatingControls(ref.current);
  }, [level]);
  if (level === "hidden") return null;
  if (level === "edit") return <>{children}</>;
  return (
    <div ref={ref} style={{ display: "contents" }} data-gate={k}>
      {children}
    </div>
  );
}
