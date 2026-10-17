import { Redirect, useLocation, useSearch } from "wouter";
import { PillTabs, type PillTabItem } from "@/components/ui/pill-tabs";

// The first level of tabs of a page that keeps its tabs in the PATH (Compensation, Outpass / Visitors / Tea Break): the pill
// row, the reading of the subtab an address names, and the redirect for a missing or unknown one. The second level is
// <NestedTabs> (nested-tabs.tsx). A subtab is a path segment (not a query key), so each has an address of its own; the
// filters in the query string go along with a switch.

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

/** The row of subtabs of a page. A switch is a new entry in the history (Back returns to the subtab before), and every
 *  filter in the query string goes with it. */
export function SubtabBar({
  base,
  items,
  value,
  testId = "subtabs",
  landing,
}: {
  base: string;
  items: PillTabItem[];
  value: string;
  testId?: string;
  /** The nested subtab a subtab opens on (its first), so a switch goes straight there instead of through a redirect. */
  landing?: (sub: string) => string | undefined;
}) {
  const [, navigate] = useLocation();
  const search = useSearch();
  return (
    <div className="max-w-full overflow-x-auto" data-testid={testId}>
      <PillTabs
        items={items}
        value={value}
        onChange={(next) => {
          const nested = landing?.(next);
          navigate(`${base}/${next}${nested ? `/${nested}` : ""}${search ? `?${search}` : ""}`);
        }}
        baseColor="#4f46e5"
        size="sm"
      />
    </div>
  );
}
