import { useEffect, useState } from "react";
import { Factory, Search, User, Users, UsersRound, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  useFetchEmployees,
  type EmploymentType,
  type FetchEmployee,
  type FetchScope,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

export type ScopeChoice = "all" | "staff" | "production" | "one";

const CHOICES: { value: ScopeChoice; label: string; icon: typeof Users }[] = [
  { value: "all", label: "Everyone", icon: UsersRound },
  { value: "staff", label: "Staff", icon: Users },
  { value: "production", label: "Production", icon: Factory },
  { value: "one", label: "One employee", icon: User },
];

/** What the run is sent: null = everyone (as before). */
export function scopeFor(choice: ScopeChoice, picked: FetchEmployee | null): FetchScope | null {
  if (choice === "staff" || choice === "production") return { employmentType: choice };
  if (choice === "one" && picked) return { employeeIds: [picked.id] };
  return null;
}

/** "Everyone", "Staff only", "Production only", "3001 Kavi Worker". */
export function scopeText(choice: ScopeChoice, picked: FetchEmployee | null): string {
  if (choice === "staff") return "staff only";
  if (choice === "production") return "production only";
  if (choice === "one") return picked ? `${picked.code} ${picked.name}` : "one employee (choose who)";
  return "everyone";
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Data Fetch -> whose punches (owner 2026-11-17): everyone, staff only, production only, or one employee picked by code or
 * name. Only active employees can be picked: only their punches are recorded.
 */
export default function FetchScopePicker({
  choice,
  onChoice,
  picked,
  onPick,
}: {
  choice: ScopeChoice;
  onChoice: (c: ScopeChoice) => void;
  picked: FetchEmployee | null;
  onPick: (e: FetchEmployee | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<EmploymentType | "">("");
  const search = useDebounced(query.trim());
  const list = useFetchEmployees(search, kind, choice === "one" && !picked);
  const items = list.data?.items ?? [];

  return (
    <section className="space-y-2.5 border-t pt-4" data-testid="fetch-scope">
      <h3 className="text-sm font-bold text-slate-800">2. Whose punches</h3>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Whose punches">
        {CHOICES.map((c) => {
          const Icon = c.icon;
          const on = choice === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChoice(c.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors",
                on ? "border-[#006496] bg-[#006496] text-white" : "bg-white text-slate-600 hover:bg-slate-50",
              )}
              data-testid={`fetch-scope-${c.value}`}
            >
              <Icon size={13} /> {c.label}
            </button>
          );
        })}
      </div>

      {choice === "one" &&
        (picked ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-xl border border-[#006496] bg-sky-50 px-3 py-2.5"
            data-testid="fetch-scope-picked"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#006496] text-xs font-bold text-white">
              {picked.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-slate-900">
                {picked.name} <span className="font-mono text-xs font-normal text-slate-500">{picked.code}</span>
              </span>
              <span className="block truncate text-xs text-slate-500">
                {picked.employmentType === "production" ? "Production" : "Staff"}
                {picked.department ? ` · ${picked.department}` : ""} ·{" "}
                {picked.onDevices.length ? `on ${picked.onDevices.join(", ")}` : "on no device (last read)"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-white"
              data-testid="fetch-scope-change"
            >
              <X size={13} /> Change
            </button>
          </div>
        ) : (
          <div className="space-y-2 rounded-xl border border-slate-200 p-3" data-testid="fetch-scope-search">
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-[14rem] flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search an active employee by code or name"
                  className="pl-8"
                  autoFocus
                  data-testid="fetch-scope-query"
                />
              </div>
              <div className="flex gap-1" role="group" aria-label="Kind of employee">
                {(["", "staff", "production"] as const).map((k) => (
                  <button
                    key={k || "all"}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={cn(
                      "h-9 rounded-lg border px-2.5 text-xs font-semibold",
                      kind === k
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "bg-white text-slate-600 hover:bg-slate-50",
                    )}
                  >
                    {k === "" ? "All" : k === "staff" ? "Staff" : "Production"}
                  </button>
                ))}
              </div>
            </div>
            <ul
              className="max-h-56 divide-y overflow-y-auto rounded-lg border border-slate-100"
              data-testid="fetch-scope-results"
            >
              {list.isLoading ? (
                <li className="px-3 py-3 text-xs text-slate-400">Searching…</li>
              ) : items.length === 0 ? (
                <li className="px-3 py-3 text-xs text-slate-400">No active employee matches.</li>
              ) : (
                items.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onPick(e)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50"
                      data-view-safe
                      data-testid={`fetch-scope-pick-${e.id}`}
                    >
                      <span className="font-mono text-slate-500">{e.code}</span>
                      <span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{e.name}</span>
                      <span className="shrink-0 text-[11px] text-slate-400">
                        {e.employmentType === "production" ? "Production" : "Staff"}
                        {e.onDevices.length
                          ? ` · ${e.onDevices.length} device${e.onDevices.length === 1 ? "" : "s"}`
                          : ""}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      <p className="text-xs text-slate-400">
        The devices send their whole log for the dates; only the chosen people&apos;s punches are taken, the rest are
        counted and left alone.
      </p>
    </section>
  );
}
