import type { PermissionLevel } from "@/contexts/AuthContext";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";

/**
 * The sub-tabs (pill switches) of a Settings tab, each with its own permission key (constants.ts SETTINGS_SUBTAB_MODULE; a
 * key with no setting of its own follows its tab, so nothing changes for a role that never set one). A hidden sub-tab is
 * not offered and never shown, also when the address, a `#setting` link or the page's search asks for it (the first one the
 * login may see is shown instead). A View-only one on a tab the login may edit is read-only: its note shows and the buttons
 * that change something are locked while it is open.
 */
export type SubtabAccess<V extends string> = {
  /** The sub-tabs the login may see, in order. */
  visible: V[];
  /** The one to show: the one asked for when the login may see it, else the first it may see. */
  shown: V;
  /** No sub-tab of the tab is open to the login. */
  none: boolean;
  /** The login's level on the shown one. */
  level: PermissionLevel;
  /** The shown one cannot be changed: its tab is View only, or it is. */
  readOnly: boolean;
  /** The shown one is View only on a tab the login may edit (the tab's own notice does not show then). */
  viewOnly: boolean;
};

export function useSubtabAccess<V extends string>(
  values: readonly V[],
  keys: Record<string, string>,
  asked: V,
  tabReadOnly: boolean,
  options: {
    /** The keys of the pills inside a sub-tab (Late Detection -> Production's cycles): a View-only sub-tab with an editable
     *  pill inside is not locked as a whole (its own parts stay read-only; the pills decide for themselves). */
    below?: Partial<Record<V, readonly string[]>>;
    /** false: no page-wide lock while a View-only one is open (its own controls take `readOnly` instead), for pills that
     *  share a Save button with editable parts around them. */
    lock?: boolean;
  } = {},
): SubtabAccess<V> {
  const levelOf = useLevel();
  const visible = visibleItems(values, (v) => keys[v], levelOf);
  const shown = pickVisible(asked, visible);
  const level: PermissionLevel = visible.length === 0 ? "hidden" : keys[shown] ? levelOf(keys[shown]) : "edit";
  const editableInside = (options.below?.[shown] ?? []).some((k) => levelOf(k) === "edit");
  const viewOnly = !tabReadOnly && level === "view" && !editableInside;
  // only the shown sub-tab is mounted, so locking the page while it is open touches its controls (and the tab's shared ones)
  useViewOnlyLock(viewOnly && options.lock !== false, shown);
  return { visible, shown, none: visible.length === 0, level, readOnly: tabReadOnly || level !== "edit", viewOnly };
}

/** The amber note above a View-only sub-tab. */
export function SubtabViewOnlyNote({ show }: { show: boolean }) {
  return <ViewOnlyTabNote show={show} testId="settings-subtab-view-only" />;
}

/** What a tab shows when none of its sub-tabs is open to the login. */
export function NothingOpen() {
  return (
    <p className="text-sm text-slate-500" data-testid="settings-nothing-open">
      Nothing on this page is open to your role.
    </p>
  );
}
