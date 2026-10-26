import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Factory, Users } from "lucide-react";
import { PillTabs } from "@/components/ui/pill-tabs";
import { ADDRESS_EVENTS, addressSetting } from "../payroll/form";
import { focusSetting } from "./jump";

/**
 * The Staff | Production pages a Settings tab can have. Attendance, Production Shifts and Late Detection each show one page
 * per kind of employee behind a pill switch, so a setting never leaves a manager wondering which employees it is for. A
 * page is named in the address as `?tab=late_detection&view=production`, and a setting's own address
 * (`?tab=late_detection#prod-late-switch`) opens the page that holds it.
 */
export type ClassView = "staff" | "production";

export const CLASS_VIEWS: readonly ClassView[] = ["staff", "production"];

/** The `view` of the page address, when it names one of `values`. */
export function addressView<V extends string>(values: readonly V[]): V | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("view") ?? "";
  return (values as readonly string[]).includes(raw) ? (raw as V) : null;
}

/**
 * Puts `view` in the page address (`?tab=late_detection&view=production`) without adding a history entry, so a refresh
 * or a copied address comes back to the same page. The `#setting` part is dropped: it named the page that was open before.
 */
export function writeAddressView(view: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
}

/**
 * The open page of a tab with pills, and the function that opens another. It starts on the page the address names (a
 * `#setting` of that page first, then `?view=`, then `fallback`) and follows every later change of the address: the
 * page's search and links land on a setting that may sit on the page that is not open. A `#setting` that is a link (not
 * the page's own search, which scrolls by itself) is scrolled to here. Choosing a pill is written into the address.
 * `values` and `viewOf` must keep their identity (module constants).
 */
export function useAddressView<V extends string>(
  values: readonly V[],
  fallback: V,
  viewOf: Record<string, V>,
): [V, (next: V) => void] {
  const [view, setView] = useState<V>(() => {
    const id = addressSetting();
    return (
      (Object.prototype.hasOwnProperty.call(viewOf, id) ? viewOf[id] : undefined) ?? addressView(values) ?? fallback
    );
  });

  useEffect(() => {
    let stop: (() => void) | undefined;
    const follow = (event?: Event) => {
      const id = addressSetting();
      const named = Object.prototype.hasOwnProperty.call(viewOf, id) ? viewOf[id] : undefined;
      const target = named ?? addressView(values);
      if (target) setView(target);
      if (!named || event?.type === "replaceState") return;
      stop?.();
      stop = focusSetting(id);
    };
    follow();
    ADDRESS_EVENTS.forEach((e) => window.addEventListener(e, follow));
    return () => {
      ADDRESS_EVENTS.forEach((e) => window.removeEventListener(e, follow));
      stop?.();
    };
  }, [values, viewOf]);

  const choose = useCallback((next: V) => {
    setView(next);
    writeAddressView(next);
  }, []);
  return [view, choose];
}

const CLASS_PILLS: { value: ClassView; label: string; icon: ReactNode }[] = [
  { value: "staff", label: "Staff", icon: <Users size={13} /> },
  { value: "production", label: "Production", icon: <Factory size={13} /> },
];

/**
 * The Staff | Production switch of a tab, with the chips that belong beside it ("Not saved yet: Production"). The page
 * under it is the tab's own; this only draws the row.
 */
export function ClassPills({
  value,
  onChange,
  children,
  testId = "settings-class-pills",
}: {
  value: ClassView;
  onChange: (next: ClassView) => void;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid={testId}>
      <PillTabs
        items={CLASS_PILLS}
        value={value}
        onChange={(v) => onChange(v as ClassView)}
        baseColor="#0f172a"
        pillBg="#f1f5f9"
      />
      {children}
    </div>
  );
}

/** The amber chip that says another page of the tab holds edits that are not saved yet. */
export function UnsavedChip({ children }: { children: ReactNode }) {
  return (
    <span
      className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200"
      data-testid="settings-unsaved-chip"
    >
      {children}
    </span>
  );
}
