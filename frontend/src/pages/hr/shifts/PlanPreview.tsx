import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  Repeat2,
  Search,
  ShieldAlert,
  UserCheck,
  UserPlus,
} from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ConflictDecision, PlanResult, PlanRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ROW_FILTERS, filterRows, prettyDate, rowFilterCounts, rowOutcome, type RowFilter } from "./shift-logic";

const PAGE = 60;

function Tile({
  icon,
  tint,
  value,
  label,
  sub,
  testId,
}: {
  icon: ReactNode;
  tint: string;
  value: number;
  label: string;
  sub?: string;
  testId: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border bg-white p-2.5" data-testid={testId}>
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tint)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xl font-black leading-none text-gray-900">{value}</p>
        <p className="mt-1 text-[11px] font-semibold leading-tight text-gray-600">{label}</p>
        {sub && <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function DecisionToggle({
  value,
  onChange,
  code,
}: {
  value: ConflictDecision;
  onChange: (v: ConflictDecision) => void;
  code: string;
}) {
  const opt = (v: ConflictDecision, label: string) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      data-testid={`decision-${v}-${code}`}
      className={cn(
        "rounded-md px-2 py-1 text-[11px] font-semibold transition-colors",
        value === v
          ? v === "reassign"
            ? "bg-amber-500 text-white shadow-sm"
            : "bg-slate-700 text-white shadow-sm"
          : "text-gray-500 hover:text-gray-800",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex shrink-0 rounded-lg bg-gray-100 p-0.5" role="group" aria-label="Keep or reassign">
      {opt("keep", "Keep")}
      {opt("reassign", "Reassign")}
    </div>
  );
}

function Row({
  row,
  decision,
  onDecision,
}: {
  row: PlanRow;
  decision: ConflictDecision;
  onDecision: (v: ConflictDecision) => void;
}) {
  const outcome = rowOutcome(row);
  const cur = row.current;
  return (
    <li
      className={cn(
        "space-y-1.5 px-3 py-2.5",
        row.status === "blocked" && "bg-red-50/60",
        row.status === "conflict" && "bg-amber-50/40",
      )}
      data-testid={`plan-row-${row.employeeCode}`}
      data-status={row.status}
      data-action={row.action}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-gray-900">
            <span className="truncate">{row.name}</span>
            <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] font-normal text-gray-600">
              {row.employeeCode}
            </code>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[row.department, row.designation].filter(Boolean).join(" · ") || "No department"}
            {row.via.length > 0 && <span className="text-gray-400"> · {row.via.join(", ")}</span>}
          </p>
        </div>
        {row.status === "conflict" ? (
          <DecisionToggle value={decision} onChange={onDecision} code={row.employeeCode} />
        ) : (
          <StatusBadge tone={outcome.tone}>{outcome.label}</StatusBadge>
        )}
      </div>
      {row.status === "conflict" && (
        <div className="rounded-lg bg-white/80 px-2.5 py-1.5 text-xs text-gray-700 ring-1 ring-amber-200/70">
          {cur && (
            <p>
              Now on <b>{cur.shiftName}</b>
              {cur.startTime && cur.endTime ? ` (${cur.startTime}–${cur.endTime})` : ""} since{" "}
              {prettyDate(cur.effectiveFrom)}
              {cur.customStartTime || cur.customEndTime || cur.saturdayOff ? ", with a custom schedule" : ""}.
            </p>
          )}
          {row.scheduled.map((s) => (
            <p key={s.assignmentId}>
              <b>{s.shiftName}</b> is scheduled from {prettyDate(s.effectiveFrom)}; reassigning cancels it.
            </p>
          ))}
          <p className={cn("mt-0.5 font-semibold", decision === "reassign" ? "text-amber-700" : "text-slate-600")}>
            {decision === "reassign"
              ? "Will be moved to the new shift."
              : "Stays as they are. Nothing changes for them."}
          </p>
        </div>
      )}
      {row.status !== "conflict" && row.reason && row.status !== "unchanged" && (
        <p className={cn("text-xs", row.status === "blocked" ? "font-medium text-red-700" : "text-muted-foreground")}>
          {row.reason}
        </p>
      )}
    </li>
  );
}

/**
 * What assigning the shift would do, employee by employee (the server's plan). The tiles are the summary; people who
 * are already on another shift get a Keep / Reassign choice, set for everyone at once and overridable per person;
 * anyone skipped, left out or blocked says why. Nothing here is written until the dialog's button is pressed.
 */
export default function PlanPreview({
  plan,
  ready,
  loading,
  shiftName,
  onConflict,
  onOnConflict,
  decisions,
  onDecision,
}: {
  plan: PlanResult | undefined;
  ready: boolean;
  loading: boolean;
  shiftName: string;
  onConflict: ConflictDecision;
  onOnConflict: (v: ConflictDecision) => void;
  decisions: Record<string, ConflictDecision>;
  onDecision: (employeeId: number, v: ConflictDecision) => void;
}) {
  const [filter, setFilter] = useState<RowFilter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => plan?.rows ?? [], [plan]);
  const filtered = useMemo(() => filterRows(rows, filter, query), [rows, filter, query]);
  const filterCounts = useMemo(() => rowFilterCounts(rows), [rows]);
  const c = plan?.counts;

  if (!ready) {
    return (
      <div
        className="flex h-full min-h-[16rem] flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center"
        data-testid="plan-empty"
      >
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-sky-500">
          <UserCheck size={22} />
        </span>
        <p className="text-sm font-semibold text-gray-700">Your preview appears here</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Choose a shift, a start date and who to include. You will see who is new, who is already on a shift and who is
          skipped before anything is saved.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="plan-preview" aria-busy={loading}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900">Preview</h3>
        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Checking…
          </span>
        )}
      </div>

      {plan && plan.errors.length > 0 && (
        <div
          className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5"
          role="alert"
          data-testid="plan-errors"
        >
          {plan.errors.map((e) => (
            <p key={e} className="flex items-start gap-2 text-xs font-medium text-red-800">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" /> {e}
            </p>
          ))}
        </div>
      )}
      {plan && plan.warnings.length > 0 && (
        <div
          className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5"
          data-testid="plan-warnings"
        >
          {plan.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 text-xs text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" /> {w}
            </p>
          ))}
        </div>
      )}

      {c && plan?.ok && (
        <>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3" data-testid="plan-tiles">
            <Tile
              testId="tile-new"
              icon={<UserPlus size={16} />}
              tint="bg-emerald-100 text-emerald-700"
              value={c.new}
              label="New to assign"
            />
            <Tile
              testId="tile-already"
              icon={<CheckCircle2 size={16} />}
              tint="bg-slate-100 text-slate-600"
              value={c.alreadyAssigned}
              label="Already assigned"
              sub={`${c.alreadyOnThisShift} on this shift · ${c.conflicts} on another`}
            />
            <Tile
              testId="tile-reassign"
              icon={<Repeat2 size={16} />}
              tint="bg-amber-100 text-amber-700"
              value={c.willReassign}
              label="Will be reassigned"
            />
            <Tile
              testId="tile-kept"
              icon={<UserCheck size={16} />}
              tint="bg-sky-100 text-sky-700"
              value={c.kept}
              label="Keeping current shift"
            />
            <Tile
              testId="tile-skipped"
              icon={<CircleSlash size={16} />}
              tint="bg-gray-100 text-gray-500"
              value={c.skipped + c.excluded}
              label="Skipped"
              sub={`${c.excluded} left out · ${c.skipped} not eligible`}
            />
            <Tile
              testId="tile-errors"
              icon={<ShieldAlert size={16} />}
              tint="bg-red-100 text-red-700"
              value={c.blocked}
              label="Needs attention"
            />
          </div>

          {c.conflicts > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3" data-testid="conflict-policy">
              <p className="text-xs font-bold text-amber-900">
                {c.conflicts} {c.conflicts === 1 ? "employee is" : "employees are"} already on a shift
              </p>
              <p className="mt-0.5 text-xs text-amber-900/80">
                Choose what happens to them. You can still decide for each person in the list.
              </p>
              <div
                className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2"
                role="radiogroup"
                aria-label="Already assigned employees"
              >
                {(
                  [
                    ["keep", "Keep their current shift", "Nothing changes for them"],
                    ["reassign", `Reassign to ${shiftName}`, "Move them all to this shift"],
                  ] as const
                ).map(([v, title, sub]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={onConflict === v}
                    onClick={() => onOnConflict(v)}
                    data-testid={`policy-${v}`}
                    className={cn(
                      "rounded-lg border bg-white px-2.5 py-2 text-left transition-all",
                      onConflict === v
                        ? "border-amber-500 ring-1 ring-amber-400/50"
                        : "border-amber-200 hover:border-amber-300",
                    )}
                  >
                    <span className="block text-xs font-bold text-gray-900">{title}</span>
                    <span className="block text-[11px] text-muted-foreground">{sub}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border bg-white">
            <div className="space-y-2 border-b p-2.5">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter the list">
                {ROW_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={filter === f.value}
                    onClick={() => {
                      setFilter(f.value);
                      setShown(PAGE);
                    }}
                    data-testid={`plan-filter-${f.value}`}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors",
                      filter === f.value
                        ? "border-blue-200 bg-blue-50 text-blue-700"
                        : "border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-800",
                    )}
                  >
                    {f.label} <span className="opacity-60">{filterCounts[f.value]}</span>
                  </button>
                ))}
              </div>
              <div className="flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15">
                <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShown(PAGE);
                  }}
                  placeholder="Search the preview…"
                  aria-label="Search the preview"
                  className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  data-testid="plan-search"
                />
              </div>
            </div>
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                {rows.length === 0 ? "Nobody matches what you chose." : "Nobody in this view."}
              </p>
            ) : (
              <ul className="max-h-[26rem] divide-y overflow-y-auto" data-testid="plan-rows">
                {filtered.slice(0, shown).map((r) => (
                  <Row
                    key={r.employeeId}
                    row={r}
                    decision={decisions[String(r.employeeId)] ?? onConflict}
                    onDecision={(v) => onDecision(r.employeeId, v)}
                  />
                ))}
                {filtered.length > shown && (
                  <li>
                    <button
                      type="button"
                      onClick={() => setShown((n) => n + PAGE)}
                      className="w-full py-2.5 text-xs font-semibold text-blue-600 hover:bg-blue-50/60"
                    >
                      Show {Math.min(PAGE, filtered.length - shown)} more ({filtered.length - shown} hidden)
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
