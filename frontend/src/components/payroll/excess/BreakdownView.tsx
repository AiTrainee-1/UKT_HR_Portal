import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, PlusCircle, Search, SearchX, Trash2, X } from "lucide-react";
import { ACCENT_UI, accentOf, type PayAccent } from "@/components/payroll/kit/accent-ui";
import { dateTime, plural } from "@/components/payroll/kit/format";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  ExcessDepartment,
  ExcessEmployeeOption,
  ExcessEmployeeRow,
  ExcessEntry,
  PayrollKind,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import {
  deptKey,
  earnedMove,
  entryWasChanged,
  hasBreakdownFilters,
  rowState,
  rowsOf,
  rupees,
  signedAmount,
  signedRupees,
  toggleAll,
  toggleId,
  totalsOfRows,
  type BreakdownFilters,
  type EntryWithRow,
  type ExcessTypeFilter,
} from "./logic";
import { KindChip, Money, RowStateChip, SourceChip } from "./parts";

const VIEW_SAFE = { [VIEW_SAFE_ATTR]: "" };
const ALL = "all";

// From xl up a row is a line of columns; below xl it is a small card (name, then the figures under it), so nothing on the
// page scrolls sideways on a phone. With edit rights the first column is the pick box.
const GRID_PICK =
  "grid-cols-[1.25rem_minmax(0,1fr)_auto] xl:grid-cols-[1.25rem_minmax(0,1.5fr)_5.5rem_5.5rem_5.5rem_minmax(0,1.3fr)_6rem_8rem_1.75rem]";
const GRID_PLAIN =
  "grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1.5fr)_5.5rem_5.5rem_5.5rem_minmax(0,1.3fr)_6rem_8rem_1.75rem]";

// ── Filters ───────────────────────────────────────────────────────────────────

export function BreakdownFilterBar({
  value,
  onChange,
  departments,
  shown,
  total,
  accent = "indigo",
}: {
  value: BreakdownFilters;
  onChange: (patch: Partial<BreakdownFilters>) => void;
  departments: { value: string; label: string }[];
  shown: number;
  total: number;
  accent?: PayAccent;
}) {
  // the search is typed here and handed up after a short pause (the address changes once, not per key)
  const [draft, setDraft] = useState(value.q);
  const committed = useRef(value.q);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    if (value.q !== committed.current) {
      committed.current = value.q;
      setDraft(value.q);
    }
  }, [value.q]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      latest.current({ q: draft });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);

  const filtered = hasBreakdownFilters(value);
  return (
    <div
      className="min-w-0 space-y-2 rounded-2xl border bg-white p-3"
      role="search"
      aria-label="Filter the breakdown"
      data-testid="excess-filters"
      {...VIEW_SAFE}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search by name, code or designation"
            aria-label="Search employees"
            className="h-10 pl-9 pr-9"
            data-testid="excess-search"
          />
          {draft && (
            <button
              type="button"
              onClick={() => {
                committed.current = "";
                setDraft("");
                onChange({ q: "" });
              }}
              aria-label="Clear the search text"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <Select value={value.dept || ALL} onValueChange={(v) => onChange({ dept: v === ALL ? "" : v })}>
          <SelectTrigger
            className="h-10 w-[calc(50%-0.25rem)] sm:w-48"
            aria-label="Department"
            data-testid="excess-filter-dept"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
            {value.dept && !departments.some((d) => d.value === value.dept) && (
              <SelectItem value={value.dept}>Department #{value.dept}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select
          value={value.kind || ALL}
          onValueChange={(v) => onChange({ kind: (v === ALL ? "" : v) as ExcessTypeFilter })}
        >
          <SelectTrigger
            className="h-10 w-[calc(50%-0.25rem)] sm:w-44"
            aria-label="Type"
            data-testid="excess-filter-kind"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Excess or detection</SelectItem>
            <SelectItem value="excess">Has an excess</SelectItem>
            <SelectItem value="detection">Has a detection</SelectItem>
          </SelectContent>
        </Select>
        <label className="inline-flex cursor-pointer items-center gap-2 px-1 text-xs font-semibold text-gray-700">
          <Switch
            checked={value.inPayrollOnly}
            onCheckedChange={(on) => onChange({ inPayrollOnly: on })}
            data-testid="excess-filter-in-payroll"
          />
          Only employees in payroll
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span data-testid="excess-shown-count">
          {filtered ? `Showing ${shown} of ${plural(total, "employee")}` : plural(total, "employee")}
        </span>
        {filtered && (
          <button
            type="button"
            className={cn("font-semibold hover:underline", ACCENT_UI[accent].link)}
            onClick={() => {
              committed.current = "";
              setDraft("");
              onChange({ q: "", dept: "", kind: "", inPayrollOnly: false });
            }}
            data-testid="excess-filters-clear"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// ── The bar of what is picked ─────────────────────────────────────────────────

export function SelectionBar({
  employees,
  entries,
  onAdd,
  onRemove,
  onClearEmployees,
  onClearEntries,
  accent = "indigo",
}: {
  employees: number;
  entries: number;
  onAdd: () => void;
  onRemove: () => void;
  onClearEmployees: () => void;
  onClearEntries: () => void;
  accent?: PayAccent;
}) {
  if (employees === 0 && entries === 0) return null;
  const ui = ACCENT_UI[accent];
  return (
    <div
      className={cn(
        "sticky bottom-3 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-3 py-2 text-sm shadow-md backdrop-blur",
        ui.bar,
      )}
      data-testid="excess-selection-bar"
    >
      {employees > 0 && (
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn("font-semibold", ui.barText)} data-testid="excess-picked-employees">
            {plural(employees, "employee")} picked
          </span>
          <Button size="sm" className={cn("h-8 gap-1.5", ui.solid)} onClick={onAdd} data-testid="excess-bulk-add">
            <PlusCircle size={13} /> Add excess or detection to them
          </Button>
          <button
            type="button"
            className={cn("text-xs font-semibold hover:underline", ui.link)}
            onClick={onClearEmployees}
          >
            Unpick
          </button>
        </span>
      )}
      {entries > 0 && (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-rose-900" data-testid="excess-picked-entries">
            {plural(entries, "entry", "entries")} picked
          </span>
          <Button
            size="sm"
            className="h-8 gap-1.5 border-0 bg-none bg-rose-600 text-white hover:bg-rose-700"
            onClick={onRemove}
            data-testid="excess-bulk-remove"
          >
            <Trash2 size={13} /> Remove {entries === 1 ? "it" : "them"}
          </Button>
          <button
            type="button"
            className="text-xs font-semibold text-rose-700 hover:underline"
            onClick={onClearEntries}
          >
            Unpick
          </button>
        </span>
      )}
    </div>
  );
}

// ── Departments and employees ─────────────────────────────────────────────────

export type BreakdownListProps = {
  departments: ExcessDepartment[];
  /** Staff or production: the page's accent and the words of the payroll state. */
  kind?: PayrollKind;
  /** May add / change / remove now (edit rights and the month not locked): pick boxes and row actions. */
  editable: boolean;
  options: ExcessEmployeeOption[];
  pickedEmployees: number[];
  onPickEmployees: (ids: number[]) => void;
  pickedEntries: number[];
  onPickEntries: (ids: number[]) => void;
  onChangeEntry: (target: EntryWithRow) => void;
  onRemoveEntries: (targets: EntryWithRow[]) => void;
  onAddFor: (employeeIds: number[]) => void;
  /** Filters on and nothing left: the reset. */
  onClearFilters: () => void;
};

export function BreakdownList({
  departments,
  kind = "staff",
  editable,
  options,
  pickedEmployees,
  onPickEmployees,
  pickedEntries,
  onPickEntries,
  onChangeEntry,
  onRemoveEntries,
  onAddFor,
  onClearFilters,
}: BreakdownListProps) {
  const accent = accentOf(kind);
  const ui = ACCENT_UI[accent];
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const ineligible = useMemo(
    () => new Map(options.filter((o) => !o.eligible).map((o) => [o.id, o.reason ?? "Cannot get an entry now"])),
    [options],
  );
  const rows = useMemo(() => rowsOf(departments), [departments]);
  const totals = useMemo(() => totalsOfRows(rows), [rows]);
  const allOpen = rows.length > 0 && rows.every((r) => open.has(r.employeeId));

  if (departments.length === 0) {
    return (
      <EmptyNote
        icon={SearchX}
        title="No employee matches these filters"
        hint="Change or clear the filters to see the rest."
        testId="excess-empty-filters"
        action={
          <Button variant="outline" className="mt-2" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }

  const toggleSet = <T,>(set: Set<T>, key: T): Set<T> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <div className="space-y-3" data-testid="excess-breakdown">
      <div className="flex flex-wrap items-center justify-end gap-3 text-xs" {...VIEW_SAFE}>
        <button
          type="button"
          className={cn("font-semibold hover:underline", ui.link)}
          onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.employeeId)))}
          data-testid="excess-toggle-all-entries"
        >
          {allOpen ? "Hide every entry" : "Show every entry"}
        </button>
        <button
          type="button"
          className={cn("font-semibold hover:underline", ui.link)}
          onClick={() =>
            setCollapsed(collapsed.size === departments.length ? new Set() : new Set(departments.map(deptKey)))
          }
          data-testid="excess-toggle-all-depts"
        >
          {collapsed.size === departments.length ? "Open every department" : "Fold every department"}
        </button>
      </div>

      {departments.map((d) => {
        const key = deptKey(d);
        const isCollapsed = collapsed.has(key);
        const pickable = d.rows.filter((r) => !ineligible.has(r.employeeId)).map((r) => r.employeeId);
        const allPicked = pickable.length > 0 && pickable.every((id) => pickedEmployees.includes(id));
        const somePicked = pickable.some((id) => pickedEmployees.includes(id));
        return (
          <section
            key={key}
            className="clay-card overflow-hidden rounded-2xl border border-slate-100"
            aria-label={d.department}
            data-testid={`excess-dept-${key}`}
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2.5">
              {editable && (
                <Checkbox
                  checked={allPicked ? true : somePicked ? "indeterminate" : false}
                  disabled={pickable.length === 0}
                  onCheckedChange={() => onPickEmployees(toggleAll(pickedEmployees, pickable))}
                  aria-label="Pick every employee of this department"
                  className={cn("border-slate-400", ui.check)}
                  data-testid={`excess-dept-pick-${key}`}
                />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed(toggleSet(collapsed, key))}
                data-testid={`excess-dept-toggle-${key}`}
                {...VIEW_SAFE}
              >
                {isCollapsed ? (
                  <ChevronRight size={15} className="shrink-0 text-gray-500" />
                ) : (
                  <ChevronDown size={15} className="shrink-0 text-gray-500" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-gray-900">
                    {d.department}
                    {d.unit && <span className="ml-1.5 text-xs font-medium text-muted-foreground">{d.unit}</span>}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{plural(d.employees, "employee")}</span>
                </span>
              </button>
              <span
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
                data-testid={`excess-dept-totals-${key}`}
              >
                <span>
                  <span className="text-muted-foreground">Excess </span>
                  <Money value={d.excessTotal} kind="excess">
                    {rupees(d.excessTotal)}
                  </Money>
                </span>
                <span>
                  <span className="text-muted-foreground">Detection </span>
                  <Money value={d.detectionTotal} kind="detection">
                    {rupees(d.detectionTotal)}
                  </Money>
                </span>
                <span>
                  <span className="text-muted-foreground">Net </span>
                  <Money value={d.net} kind="net" accent={accent}>
                    {signedRupees(d.net)}
                  </Money>
                </span>
              </span>
            </header>
            {!isCollapsed && (
              <div className="text-sm">
                <div
                  className={cn(
                    "hidden gap-x-3 bg-white px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 xl:grid",
                    editable ? GRID_PICK : GRID_PLAIN,
                  )}
                  aria-hidden="true"
                >
                  {editable && <span />}
                  <span>Employee</span>
                  <span className="text-right">Excess</span>
                  <span className="text-right">Detection</span>
                  <span className="text-right">Net</span>
                  <span>Earned salary</span>
                  <span className="text-right">NET pay</span>
                  <span>Payroll</span>
                  <span />
                </div>
                <ul className="divide-y divide-slate-100">
                  {d.rows.map((row) => (
                    <EmployeeRow
                      key={row.employeeId}
                      row={row}
                      kind={kind}
                      editable={editable}
                      picked={pickedEmployees.includes(row.employeeId)}
                      pickBlocked={ineligible.get(row.employeeId) ?? null}
                      onPick={() => onPickEmployees(toggleId(pickedEmployees, row.employeeId))}
                      open={open.has(row.employeeId)}
                      onToggle={() => setOpen(toggleSet(open, row.employeeId))}
                      pickedEntries={pickedEntries}
                      onPickEntries={onPickEntries}
                      onChangeEntry={(entry) => onChangeEntry({ entry, row })}
                      onRemoveEntry={(entry) => onRemoveEntries([{ entry, row }])}
                      onAdd={() => onAddFor([row.employeeId])}
                    />
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}

      {departments.length > 1 && (
        <p
          className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 rounded-xl bg-slate-50 px-3 py-2 text-xs"
          data-testid="excess-shown-totals"
        >
          <span className="font-semibold text-gray-700">{plural(totals.employees, "employee")} shown</span>
          <span>
            <span className="text-muted-foreground">Excess </span>
            <Money value={totals.excessTotal} kind="excess">
              {rupees(totals.excessTotal)}
            </Money>
          </span>
          <span>
            <span className="text-muted-foreground">Detection </span>
            <Money value={totals.detectionTotal} kind="detection">
              {rupees(totals.detectionTotal)}
            </Money>
          </span>
          <span>
            <span className="text-muted-foreground">Net </span>
            <Money value={totals.net} kind="net" accent={accent}>
              {signedRupees(totals.net)}
            </Money>
          </span>
        </p>
      )}
    </div>
  );
}

function EmployeeRow({
  row,
  kind,
  editable,
  picked,
  pickBlocked,
  onPick,
  open,
  onToggle,
  pickedEntries,
  onPickEntries,
  onChangeEntry,
  onRemoveEntry,
  onAdd,
}: {
  row: ExcessEmployeeRow;
  kind: PayrollKind;
  editable: boolean;
  picked: boolean;
  /** Why this employee cannot get a new entry now (inactive ...), or null. */
  pickBlocked: string | null;
  onPick: () => void;
  open: boolean;
  onToggle: () => void;
  pickedEntries: number[];
  onPickEntries: (ids: number[]) => void;
  onChangeEntry: (entry: ExcessEntry) => void;
  onRemoveEntry: (entry: ExcessEntry) => void;
  onAdd: () => void;
}) {
  const accent = accentOf(kind);
  const ui = ACCENT_UI[accent];
  const earned = earnedMove(row);
  const state = rowState(row);
  const label = (text: string) => <span className="text-[11px] text-muted-foreground xl:hidden">{text} </span>;
  return (
    <li className={cn(picked && ui.pickedRow)} data-testid={`excess-row-${row.code}`}>
      <div
        className={cn(
          "grid items-start gap-x-3 gap-y-1.5 px-3 py-2.5 xl:items-center",
          editable ? GRID_PICK : GRID_PLAIN,
        )}
      >
        {editable && (
          <span className="pt-0.5 xl:pt-0" title={pickBlocked ?? undefined}>
            <Checkbox
              checked={picked}
              disabled={!!pickBlocked}
              onCheckedChange={onPick}
              aria-label="Pick this employee"
              className={cn("border-slate-400", ui.check)}
              data-testid={`excess-pick-${row.code}`}
            />
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-900">{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{row.code}</span>
            {row.designation ? ` · ${row.designation}` : ""}
          </p>
        </div>
        {/* below xl: one wrapped line of figures under the name; from xl: each figure in its own column */}
        <div
          className={cn(
            "col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 xl:contents",
            editable ? "col-start-2" : "col-start-1",
          )}
        >
          <span className="xl:text-right" data-testid={`excess-row-excess-${row.code}`}>
            {label("Excess")}
            <Money value={row.excess} kind="excess">
              {rupees(row.excess)}
            </Money>
          </span>
          <span className="xl:text-right" data-testid={`excess-row-detection-${row.code}`}>
            {label("Detection")}
            <Money value={row.detection} kind="detection">
              {rupees(row.detection)}
            </Money>
          </span>
          <span className="xl:text-right" data-testid={`excess-row-net-${row.code}`}>
            {label("Net")}
            <Money value={row.net} kind="net" accent={accent}>
              {signedRupees(row.net)}
            </Money>
          </span>
          <span className="min-w-0 text-xs xl:text-sm" data-testid={`excess-row-earned-${row.code}`}>
            {label("Earned")}
            {earned ? (
              <span className="tabular-nums text-gray-700">
                {rupees(earned.before)} <span className="text-gray-400">→</span>{" "}
                <span className="font-semibold text-gray-900">{rupees(earned.after)}</span>
              </span>
            ) : (
              <span className="text-gray-400" title="No payroll for this employee yet">
                —
              </span>
            )}
          </span>
          <span className="text-xs xl:text-right xl:text-sm" data-testid={`excess-row-netpay-${row.code}`}>
            {label("NET pay")}
            <span className={cn("tabular-nums", row.netPay === null ? "text-gray-400" : "font-semibold text-gray-900")}>
              {rupees(row.netPay)}
            </span>
          </span>
          <span data-testid={`excess-row-state-${row.code}`}>
            <RowStateChip state={state} kind={kind} />
          </span>
        </div>
        <button
          type="button"
          className={cn(
            "row-start-1 inline-flex h-7 w-7 items-center justify-center justify-self-end rounded-lg text-gray-500 hover:bg-slate-100 hover:text-gray-800 xl:col-start-auto xl:row-start-auto",
            editable ? "col-start-3" : "col-start-2",
          )}
          aria-expanded={open}
          aria-label={open ? "Hide the entries" : "Show the entries"}
          title={open ? "Hide the entries" : `Show the ${plural(row.entries.length, "entry", "entries")}`}
          onClick={onToggle}
          data-testid={`excess-row-toggle-${row.code}`}
          {...VIEW_SAFE}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>

      {open && (
        <div
          className="border-t border-dashed border-slate-200 bg-slate-50/60 px-3 py-2.5"
          data-testid={`excess-entries-${row.code}`}
        >
          <ul className="space-y-2">
            {row.entries.map((entry) => (
              <EntryItem
                key={entry.id}
                entry={entry}
                editable={editable}
                picked={pickedEntries.includes(entry.id)}
                onPick={() => onPickEntries(toggleId(pickedEntries, entry.id))}
                onChange={() => onChangeEntry(entry)}
                onRemove={() => onRemoveEntry(entry)}
              />
            ))}
          </ul>
          {editable && !pickBlocked && (
            <button
              type="button"
              className={cn("mt-2 inline-flex items-center gap-1 text-xs font-semibold hover:underline", ui.link)}
              onClick={onAdd}
              data-testid={`excess-row-add-${row.code}`}
            >
              <PlusCircle size={12} /> Add another entry for this employee
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function EntryItem({
  entry,
  editable,
  picked,
  onPick,
  onChange,
  onRemove,
}: {
  entry: ExcessEntry;
  editable: boolean;
  picked: boolean;
  onPick: () => void;
  onChange: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-xl border bg-white px-3 py-2",
        picked ? "border-rose-200 ring-1 ring-rose-200" : "border-slate-200",
      )}
      data-testid={`excess-entry-${entry.id}`}
    >
      {editable && (
        <Checkbox
          checked={picked}
          onCheckedChange={onPick}
          aria-label="Pick this entry"
          className="mt-0.5 border-slate-400 data-[state=checked]:border-rose-600 data-[state=checked]:bg-rose-600"
          data-testid={`excess-entry-pick-${entry.id}`}
        />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <KindChip kind={entry.kind} />
          <SourceChip source={entry.source} />
          <Money value={entry.amount} kind={entry.kind} className="text-sm">
            {signedRupees(signedAmount(entry.kind, entry.amount))}
          </Money>
        </div>
        <p
          className="whitespace-pre-line break-words text-sm text-gray-800"
          data-testid={`excess-entry-remark-${entry.id}`}
        >
          {entry.remark}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Added by {entry.createdBy ?? "—"} · {dateTime(entry.createdAt)}
          {entryWasChanged(entry) && (
            <>
              {" "}
              · changed by {entry.updatedBy ?? "—"} · {dateTime(entry.updatedAt)}
            </>
          )}
        </p>
      </div>
      {editable && (
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onChange}
            title="Edit the amount (with a reason)"
            data-testid={`excess-entry-change-${entry.id}`}
          >
            <Pencil size={12} /> Change
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 border-rose-200 px-2 text-xs text-rose-700 hover:bg-rose-50"
            onClick={onRemove}
            title="Remove this entry (with a reason)"
            data-testid={`excess-entry-remove-${entry.id}`}
          >
            <Trash2 size={12} /> Remove
          </Button>
        </div>
      )}
    </li>
  );
}
