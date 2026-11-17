import { useState, type ReactNode } from "react";
import { Factory, Users, UsersRound } from "lucide-react";
import type { EmploymentType } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

/** The sub-tab the address names (`?view=`), else the first. */
export function readView<T extends string>(allowed: readonly T[]): T {
  try {
    const v = new URLSearchParams(window.location.search).get("view") as T | null;
    return v && allowed.includes(v) ? v : allowed[0];
  } catch {
    return allowed[0];
  }
}

/** Puts the sub-tab in the address (replacing the entry, so Back leaves the page) and keeps every other query key. */
export function writeView(view: string, first: string) {
  try {
    const url = new URL(window.location.href);
    if (view === first) url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* the address just is not updated */
  }
}

/** A tab's sub-tab, kept in the address so a refresh or a shared link opens it again. */
export function useView<T extends string>(allowed: readonly T[]): [T, (v: T) => void] {
  const [view, setView] = useState<T>(() => readView(allowed));
  return [
    view,
    (v: T) => {
      setView(v);
      writeView(v, allowed[0]);
    },
  ];
}

export type SubTab<T extends string> = { value: T; label: string; icon: ReactNode; count?: number | null };

/** The sub-tab row of a Device Control tab (owner 2026-11-17: Link / Unlink and Data Push are split into sub-tabs). */
export function SubTabBar<T extends string>({
  items,
  value,
  onChange,
  testId,
}: {
  items: SubTab<T>[];
  value: T;
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto pb-0.5" data-tab-row>
      <div
        className="inline-flex items-center gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm"
        role="tablist"
        data-testid={testId}
      >
        {items.map((t) => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.value)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-xs font-semibold transition-colors",
                on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
              )}
              data-view-safe
              data-testid={`${testId}-${t.value}`}
            >
              {t.icon}
              {t.label}
              {t.count != null && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                    on ? "bg-white text-slate-900" : "bg-slate-100 text-slate-600",
                  )}
                >
                  {t.count.toLocaleString("en-IN")}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const KINDS: { value: EmploymentType | ""; label: string; icon: typeof Users }[] = [
  { value: "", label: "All employees", icon: UsersRound },
  { value: "staff", label: "Staff", icon: Users },
  { value: "production", label: "Production", icon: Factory },
];

/** Staff / Production / everyone (owner 2026-11-17: separate management of the two kinds throughout Device Control). */
export function EmploymentFilter({
  value,
  onChange,
  testId,
}: {
  value: EmploymentType | "";
  onChange: (v: EmploymentType | "") => void;
  testId: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-xl bg-slate-100 p-1"
      role="group"
      aria-label="Kind of employee"
      data-testid={testId}
    >
      {KINDS.map((k) => {
        const Icon = k.icon;
        const on = value === k.value;
        return (
          <button
            key={k.value || "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(k.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors",
              on ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-900",
            )}
            data-view-safe
            data-testid={`${testId}-${k.value || "all"}`}
          >
            <Icon size={13} /> {k.label}
          </button>
        );
      })}
    </div>
  );
}
