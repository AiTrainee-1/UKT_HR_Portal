import { useRef } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { PillTabs, type PillTabItem } from "@/components/ui/pill-tabs";

// The first level of tabs of a page that keeps its tabs in the PATH (Compensation, Outpass / Visitors / Tea Break): the pill
// row, the reading of the subtab an address names, and the redirect for a missing or unknown one. The second level is
// <NestedTabs> (nested-tabs.tsx). A subtab is a path segment (not a query key), so each has an address of its own; the
// filters in the query string go along with a switch (except the keys a subtab owns, see `ownKeys`).

/**
 * The subtab an address names: the segment after `base` (`/hr/compensation/ot-detection/type-1` -> `type-1`), or null when
 * it is missing or unknown (the caller then redirects to the first one, see `<ToFirstSubtab>`).
 */
export function useSubtab<T extends string>(base: string, values: readonly T[]): T | null {
  const [path] = useLocation();
  const rest = path.startsWith(`${base}/`)
    ? path
        .slice(base.length + 1)
        .split("/")[0]
        .toLowerCase()
    : "";
  return values.find((v) => v === rest) ?? null;
}

/** Sends the bare page (or an unknown subtab / nested subtab) to its first one, replacing the entry, with the query string kept. */
export function ToFirstSubtab({ base, first }: { base: string; first: string }) {
  const search = useSearch();
  return <Redirect to={`${base}/${first}${search ? `?${search}` : ""}`} replace />;
}

/** The address keys each subtab's own list owns (its filters and its page), by subtab value. */
export type SubtabOwnKeys = Readonly<Record<string, readonly string[]>>;

/**
 * The query string a switch from subtab `from` to subtab `to` opens with, when subtabs own keys (`SubtabBar` `ownKeys`):
 * `from`'s own keys stay behind (put aside in `kept`), `to` gets back the own keys it had when it was last left (its
 * filters as they were), and every other key goes along as before. `kept` is written to (the bar's memory).
 */
export function switchQuery(
  search: string,
  from: string,
  to: string,
  ownKeys: SubtabOwnKeys,
  kept: Record<string, string>,
): string {
  const params = new URLSearchParams(search);
  const mine = ownKeys[from];
  if (mine) {
    const aside = new URLSearchParams();
    for (const key of mine) {
      const value = params.get(key);
      if (value !== null) aside.set(key, value);
      params.delete(key);
    }
    kept[from] = aside.toString();
  }
  const theirs = ownKeys[to];
  if (theirs && kept[to] !== undefined) {
    for (const key of theirs) params.delete(key);
    for (const [key, value] of new URLSearchParams(kept[to])) params.set(key, value);
  }
  return params.toString();
}

/** The row of subtabs of a page. A switch is a new entry in the history (Back returns to the subtab before), and every
 *  filter in the query string goes with it, except the keys a subtab owns (`ownKeys`). */
export function SubtabBar({
  base,
  items,
  value,
  testId = "subtabs",
  landing,
  ownKeys,
}: {
  base: string;
  items: PillTabItem[];
  value: string;
  testId?: string;
  /** The nested subtab a subtab opens on (its first), so a switch goes straight there instead of through a redirect. */
  landing?: (sub: string) => string | undefined;
  /**
   * For subtabs whose lists use the same address keys for different things (Gate Pass: In/Out's `q`, dates and `page`
   * are not Manage Gates' records ones): the keys each such subtab owns. A switch leaves them with their subtab and
   * gives them back when it is opened again from this bar (see `switchQuery`); without it every key goes along.
   */
  ownKeys?: SubtabOwnKeys;
}) {
  const [, navigate] = useLocation();
  const search = useSearch();
  // the own keys each subtab had when it was left (only with `ownKeys`); the bar stays mounted across its switches
  const kept = useRef<Record<string, string>>({});
  return (
    <div className="max-w-full overflow-x-auto" data-testid={testId}>
      <PillTabs
        items={items}
        value={value}
        onChange={(next) => {
          const nested = landing?.(next);
          const query = ownKeys ? switchQuery(search, value, next, ownKeys, kept.current) : search;
          navigate(`${base}/${next}${nested ? `/${nested}` : ""}${query ? `?${query}` : ""}`);
        }}
        baseColor="#4f46e5"
        size="sm"
      />
    </div>
  );
}
