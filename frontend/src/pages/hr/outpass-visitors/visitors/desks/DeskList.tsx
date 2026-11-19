import { ConciergeBell, Layers, Plus } from "lucide-react";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { Skeleton } from "@/components/ui/skeleton";
import type { ManagedDesk } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { fmtCount, fmtWhen, SearchFilter, SelectFilter, StatusChip } from "../../kit";
import { GateButton } from "../../gates/parts";
import { STATUS_OPTIONS, type DeskSelection } from "./logic";

/**
 * Choosing a desk only shows it, so the View only lock (lib/view-only-lock) must never disable a card: it judges a button
 * by the words in its name, and a desk called "Block A" or a branch called "New Unit" would read as a change.
 */
const VIEW_SAFE = { [VIEW_SAFE_ATTR]: "" };

/** "08:41 today", "17:05 · 16 Nov", or "No records yet". */
function lastActivity(value: string | null): string {
  if (!value) return "No records yet";
  const { time, date } = fmtWhen(value);
  return date ? `${time} · ${date}` : `${time} today`;
}

function DeskCard({ desk, selected, onSelect }: { desk: ManagedDesk; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${desk.name}, ${desk.branchName ?? "no branch"}, ${desk.isActive ? "switched on" : "switched off"}`}
      className={cn(
        "block w-full min-w-0 rounded-2xl border bg-white px-3.5 py-3 text-left transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        selected
          ? "border-primary border-l-4 pl-3 ring-1 ring-primary/30"
          : "border-slate-200/80 hover:border-slate-300",
        !desk.isActive && "bg-slate-50/70",
      )}
      data-testid={`desk-card-${desk.id}`}
      {...VIEW_SAFE}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("min-w-0 truncate font-semibold", desk.isActive ? "text-slate-900" : "text-slate-500")}>
          {desk.name}
        </span>
        {desk.branchName && (
          <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
            {desk.branchName}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <StatusChip tone={desk.isActive ? "teal" : "slate"}>{desk.isActive ? "On" : "Off"}</StatusChip>
        </span>
      </div>
      <p className="mt-0.5 truncate font-mono text-xs text-slate-500">{desk.username}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="min-w-0 truncate tabular-nums">{lastActivity(desk.lastActivityAt)}</span>
        <span className="shrink-0 font-medium tabular-nums text-slate-700">{fmtCount(desk.counts.today)} today</span>
      </div>
    </button>
  );
}

/**
 * The left column: "All desks" (records from every desk), then one card per desk (name, branch, on / off, username, last
 * activity, records today). The search and the status filter go to the server (GET /api/reception-devices?q&deskStatus).
 */
export function DeskList({
  desks,
  loading,
  error,
  selection,
  onSelect,
  search,
  onSearch,
  status,
  onStatus,
  canEdit,
  onAdd,
  className,
}: {
  desks: readonly ManagedDesk[] | undefined;
  loading: boolean;
  error: boolean;
  /** The desk shown on the right (its id), "all", or "" (none chosen: the first one is shown on a wide screen). */
  selection: DeskSelection;
  onSelect: (selection: number | "all") => void;
  search: string;
  onSearch: (q: string) => void;
  status: string;
  onStatus: (status: string) => void;
  canEdit: boolean;
  onAdd: () => void;
  className?: string;
}) {
  const filtered = !!search || !!status;
  const list = desks ?? [];
  return (
    <div className={cn("min-w-0 space-y-3", className)} data-testid="desk-list">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white p-3">
        <SearchFilter
          value={search}
          onChange={onSearch}
          placeholder="Search desks"
          label="Search desks by name, username, location or branch"
          testId="desk-search"
          className="sm:w-full"
        />
        <SelectFilter
          label="Status"
          value={status}
          onChange={onStatus}
          options={STATUS_OPTIONS}
          allLabel="On and off"
          testId="desk-status-filter"
          className="w-full sm:w-full sm:[&_select]:max-w-none"
        />
      </div>

      <button
        type="button"
        onClick={() => onSelect("all")}
        aria-pressed={selection === "all"}
        className={cn(
          "flex w-full items-center gap-3 rounded-2xl border bg-white px-3.5 py-3 text-left transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          selection === "all"
            ? "border-primary border-l-4 pl-3 ring-1 ring-primary/30"
            : "border-slate-200/80 hover:border-slate-300",
        )}
        data-testid="desk-card-all"
        {...VIEW_SAFE}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Layers size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-slate-900">All desks</span>
          <span className="block truncate text-xs text-slate-500">Records from every desk, with a desk filter</span>
        </span>
      </button>

      <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500" aria-live="polite">
        {loading && !desks ? "Desks" : `Desks (${list.length})`}
      </p>

      {loading && !desks ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only" role="status">
            Loading…
          </span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[84px] w-full rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
          Could not load the desks. Use Refresh to try again.
        </p>
      ) : list.length === 0 ? (
        <EmptyNote
          icon={ConciergeBell}
          title={filtered ? "No desk matches" : "No reception desks yet"}
          hint={filtered ? "Try another search, or show desks that are on and off." : "Add a desk to give it a login."}
          action={
            !filtered && canEdit ? (
              <GateButton tone="primary" icon={Plus} onClick={onAdd}>
                Add desk
              </GateButton>
            ) : undefined
          }
          testId="desk-list-empty"
        />
      ) : (
        <ul className="space-y-2" aria-label="Reception desks">
          {list.map((desk) => (
            <li key={desk.id}>
              <DeskCard desk={desk} selected={selection === desk.id} onSelect={() => onSelect(desk.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
