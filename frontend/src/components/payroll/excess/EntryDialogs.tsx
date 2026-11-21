import { useMemo, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, MinusCircle, Pencil, PlusCircle, Search, Trash2, X } from "lucide-react";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { dateTime, plural } from "@/components/payroll/kit/format";
import { BusyIcon } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  usePayrollExcessActions,
  type AddExcessResult,
  type ExcessEmployeeOption,
  type ExcessKind,
  type PayrollKind,
  type PayrollScope,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  KIND_LABEL,
  addButtonLabel,
  addSummary,
  amountError,
  changePreview,
  eligibleOnly,
  employeeNoun,
  optionMatches,
  parseAmount,
  payrollLine,
  remarkError,
  rupees,
  signedAmount,
  signedRupees,
  sortOptions,
  type EntryWithRow,
} from "./logic";
import { AmountField, KindChip, KindSegment, Money, RemarkField, errorText } from "./parts";

// The three dialogs of the Excess tab: add (one employee or several, the same amount each), change an entry's amount and
// remove entries. A remark / reason is mandatory in each one (3-500 characters); the server checks the same rules. Each
// works on one staff month or one production period and writes to that payroll's own endpoints.

const DIALOG_CLASS = "max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto";
// The buttons stay in view while the form scrolls on a short screen (owner 2026-11-20: dialogs were cut off).
const STICKY_FOOTER =
  "sticky -bottom-6 z-10 -mx-6 -mb-6 rounded-b-2xl border-t border-slate-200/70 bg-white/95 px-6 pb-6 pt-3 backdrop-blur sm:rounded-b-3xl";

// ── Add ───────────────────────────────────────────────────────────────────────

/** Add an Excess or a Detection to one employee or several (the same amount for each). */
export function AddEntryDialog({
  open,
  onClose,
  scope,
  periodLabel,
  options,
  initialEmployeeIds = [],
  initialKind = "excess",
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** After a save that added at least one entry (the page lets go of its picked employees). */
  onSaved?: () => void;
  /** The staff month or production period the amount is for. */
  scope: PayrollScope;
  periodLabel: string;
  options: ExcessEmployeeOption[];
  /** Employees picked before the dialog opened (bulk from the breakdown): ineligible ones are dropped. */
  initialEmployeeIds?: number[];
  initialKind?: ExcessKind;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={cn(DIALOG_CLASS, "max-w-xl")} data-testid="excess-add-dialog">
        {open && (
          <AddEntryForm
            onClose={onClose}
            scope={scope}
            periodLabel={periodLabel}
            options={options}
            initialEmployeeIds={initialEmployeeIds}
            initialKind={initialKind}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddEntryForm({
  onClose,
  scope,
  periodLabel,
  options,
  initialEmployeeIds,
  initialKind,
  onSaved,
}: {
  onClose: () => void;
  scope: PayrollScope;
  periodLabel: string;
  options: ExcessEmployeeOption[];
  initialEmployeeIds: number[];
  initialKind: ExcessKind;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const { add } = usePayrollExcessActions(scope.kind);
  const accent = ACCENT_UI[accentOf(scope.kind)];
  const [kind, setKind] = useState<ExcessKind>(initialKind);
  const [amountText, setAmountText] = useState("");
  const [remark, setRemark] = useState("");
  const [picked, setPicked] = useState<number[]>(() => eligibleOnly(initialEmployeeIds, options));
  const [q, setQ] = useState("");
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<AddExcessResult | null>(null);

  const sorted = useMemo(() => sortOptions(options), [options]);
  const shown = useMemo(() => sorted.filter((o) => optionMatches(o, q)), [sorted, q]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const shownEligible = shown.filter((o) => o.eligible).map((o) => o.id);
  const allShownPicked = shownEligible.length > 0 && shownEligible.every((id) => pickedSet.has(id));

  const amount = parseAmount(amountText);
  const amountErr = amountError(amountText);
  const remarkErr = remarkError(remark);
  const pickErr = picked.length === 0 ? "Pick at least one employee." : null;
  const names = picked.map((id) => byId.get(id)?.name ?? `#${id}`);
  const summary = addSummary(kind, amountErr ? null : amount, names);
  const saving = add.isPending;

  const toggle = (o: ExcessEmployeeOption) => {
    if (!o.eligible) return;
    setPicked((list) => (list.includes(o.id) ? list.filter((x) => x !== o.id) : [...list, o.id]));
  };
  const toggleShown = () =>
    setPicked((list) =>
      allShownPicked
        ? list.filter((id) => !shownEligible.includes(id))
        : [...list, ...shownEligible.filter((id) => !list.includes(id))],
    );

  const save = async () => {
    setTried(true);
    if (amountErr || remarkErr || pickErr || amount === null) return;
    try {
      const res = await add.mutateAsync({ scope, kind, amount, remark: remark.trim(), employeeIds: picked });
      const createdCount = res.created.length;
      if (createdCount > 0) onSaved?.();
      if (res.refused.length > 0) {
        setResult(res);
        return;
      }
      toast({
        title:
          createdCount === 1
            ? `${KIND_LABEL[kind]} of ${rupees(amount)} added for ${names[0]}`
            : `${KIND_LABEL[kind]} of ${rupees(amount)} added for ${createdCount} employees`,
        description: payrollLine(res.payrollUpdated, scope.kind),
      });
      onClose();
    } catch (err) {
      toast({
        title: `Could not add the ${kind === "excess" ? "excess" : "detection"}`,
        description: errorText(err),
        variant: "destructive",
      });
    }
  };

  if (result) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" />
            {result.created.length > 0
              ? `Added for ${plural(result.created.length, "employee")}, ${result.refused.length} refused`
              : `Nothing added: ${plural(result.refused.length, "employee")} refused`}
          </DialogTitle>
          <DialogDescription>
            {result.created.length > 0 && `${payrollLine(result.payrollUpdated, scope.kind)} `}
            The server did not add the amount for the employees below.
          </DialogDescription>
        </DialogHeader>
        <ul
          className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-amber-200 bg-amber-50/60"
          data-testid="excess-refused"
        >
          {result.refused.map((r) => (
            <li key={r.employeeId} className="px-3 py-2 text-sm" data-testid={`excess-refused-${r.employeeId}`}>
              <p className="font-semibold text-gray-900">
                {r.name} <span className="font-mono text-xs font-normal text-muted-foreground">{r.code}</span>
              </p>
              <p className="text-xs text-amber-900">{r.reason}</p>
            </li>
          ))}
        </ul>
        <DialogFooter className={STICKY_FOOTER}>
          <Button onClick={onClose} data-testid="excess-refused-close">
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PlusCircle size={16} className={accent.icon} /> Add excess or detection
        </DialogTitle>
        <DialogDescription>
          For {periodLabel}. Excess is added to the employee&apos;s earned salary, Detection is taken off it.
        </DialogDescription>
      </DialogHeader>

      <form
        className="min-w-0 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <KindSegmentField kind={kind} onChange={setKind} disabled={saving} payroll={scope.kind} />

        <AmountField
          value={amountText}
          onChange={setAmountText}
          error={tried || amountText.trim() !== "" ? amountErr : null}
          label={picked.length > 1 ? "Amount for each employee (₹)" : "Amount (₹)"}
          hint="More than zero, at most ₹10,00,000."
        />

        <RemarkField
          value={remark}
          onChange={setRemark}
          error={tried || remark.trim().length > 500 ? remarkErr : null}
          label="Remark"
          placeholder={
            kind === "excess" ? "Why this is added, e.g. Festival incentive approved by MD" : "Why this is taken off"
          }
        />

        <div className="space-y-2" data-testid="excess-picker">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-xs font-semibold text-gray-700">
              Employees <span className="text-red-600">*</span>
            </p>
            <p className="text-[11px] text-muted-foreground" data-testid="excess-picked-count">
              {picked.length === 0 ? "None picked" : `${plural(picked.length, "employee")} picked`}
            </p>
          </div>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="excess-picked">
              {picked.slice(0, 8).map((id) => (
                <span
                  key={id}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 text-[11px] font-semibold",
                    accent.pill,
                  )}
                >
                  <span className="truncate">{byId.get(id)?.name ?? `#${id}`}</span>
                  <button
                    type="button"
                    className={cn("rounded-full p-0.5", accent.pillHover)}
                    aria-label="Take this employee out of the selection"
                    onClick={() => setPicked((list) => list.filter((x) => x !== id))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {picked.length > 8 && (
                <span className={cn("text-[11px] font-semibold", accent.link)}>and {picked.length - 8} more</span>
              )}
            </div>
          )}
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, code or department"
              aria-label="Search employees"
              className="h-9 pl-8"
              data-testid="excess-picker-search"
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-muted-foreground">
              {shown.length === options.length
                ? plural(options.length, employeeNoun(scope.kind))
                : `${shown.length} of ${options.length} shown`}
            </span>
            <span className="flex items-center gap-3">
              <button
                type="button"
                className={cn("font-semibold hover:underline disabled:opacity-40", accent.link)}
                disabled={shownEligible.length === 0}
                onClick={toggleShown}
                data-testid="excess-picker-all"
              >
                {allShownPicked ? "Unpick the shown" : "Pick all shown"}
              </button>
              <button
                type="button"
                className="font-semibold text-gray-500 hover:underline disabled:opacity-40"
                disabled={picked.length === 0}
                onClick={() => setPicked([])}
                data-testid="excess-picker-none"
              >
                Clear
              </button>
            </span>
          </div>
          <ul
            className={cn(
              "max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-xl border bg-white",
              tried && pickErr ? "border-red-300" : "border-slate-200",
            )}
            role="listbox"
            aria-multiselectable="true"
            aria-label={scope.kind === "production" ? "Production employees" : "Staff employees"}
            data-testid="excess-picker-list"
          >
            {shown.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">No employee matches the search.</li>
            )}
            {shown.map((o) => {
              const on = pickedSet.has(o.id);
              return (
                <li key={o.id} role="option" aria-selected={on} aria-disabled={!o.eligible}>
                  <button
                    type="button"
                    disabled={!o.eligible}
                    onClick={() => toggle(o)}
                    className={cn(
                      "flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm",
                      o.eligible ? "hover:bg-slate-50" : "cursor-not-allowed bg-slate-50/60",
                      on && accent.optionOn,
                    )}
                    title={o.eligible ? undefined : (o.reason ?? "Cannot be picked")}
                    data-testid={`excess-option-${o.id}`}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                        on ? accent.boxOn : "border-slate-300 bg-white",
                        !o.eligible && "border-slate-200 bg-slate-100",
                      )}
                      aria-hidden="true"
                    >
                      {on && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn("block truncate font-semibold", o.eligible ? "text-gray-900" : "text-gray-400")}
                      >
                        {o.name} <span className="font-mono text-xs font-normal text-muted-foreground">{o.code}</span>
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[o.designation, o.department].filter(Boolean).join(" · ") || "—"}
                      </span>
                      {!o.eligible && (
                        <span className="mt-0.5 block text-[11px] font-medium text-amber-700">
                          {o.reason ?? "Cannot be picked"}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {tried && pickErr && (
            <p className="text-xs font-medium text-red-600" data-testid="excess-picker-error">
              {pickErr}
            </p>
          )}
        </div>

        {summary && (
          <p
            className={cn(
              "rounded-xl border px-3 py-2 text-sm font-semibold",
              kind === "excess"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-rose-200 bg-rose-50 text-rose-900",
            )}
            data-testid="excess-add-summary"
          >
            {summary}
          </p>
        )}

        <DialogFooter className={cn("gap-2", STICKY_FOOTER)}>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className={cn("gap-2", accent.solid)} disabled={saving} data-testid="excess-add-save">
            <BusyIcon busy={saving} icon={PlusCircle} />
            {addButtonLabel(kind, amountErr ? null : amount, picked.length)}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function KindSegmentField({
  kind,
  onChange,
  disabled,
  payroll,
}: {
  kind: ExcessKind;
  onChange: (kind: ExcessKind) => void;
  disabled?: boolean;
  payroll: PayrollKind;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-gray-700">Type</p>
      <KindSegment value={kind} onChange={onChange} disabled={disabled} accent={accentOf(payroll)} />
    </div>
  );
}

// ── Change ────────────────────────────────────────────────────────────────────

/** Change one entry's amount, with the reason for the change (the kind stays: remove and add for the other one). */
export function ChangeEntryDialog({
  target,
  kind,
  periodLabel,
  onClose,
}: {
  target: EntryWithRow | null;
  /** Staff or production: which payroll's endpoint changes the entry. */
  kind: PayrollKind;
  periodLabel: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={cn(DIALOG_CLASS, "max-w-md")} data-testid="excess-change-dialog">
        {target && (
          <ChangeEntryForm
            key={target.entry.id}
            target={target}
            kind={kind}
            periodLabel={periodLabel}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChangeEntryForm({
  target,
  kind,
  periodLabel,
  onClose,
}: {
  target: EntryWithRow;
  kind: PayrollKind;
  periodLabel: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { change } = usePayrollExcessActions(kind);
  const accent = ACCENT_UI[accentOf(kind)];
  const { entry, row } = target;
  const [amountText, setAmountText] = useState(String(entry.amount));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);

  const amount = parseAmount(amountText);
  const sameAmount = amount !== null && Math.abs(amount - entry.amount) < 0.005;
  const amountErr = amountError(amountText) ?? (sameAmount ? "This is the amount now: enter a different one." : null);
  const reasonErr = remarkError(reason, "reason");
  const preview = changePreview(entry.amount, amountText);
  const saving = change.isPending;

  const save = async () => {
    setTried(true);
    if (amountErr || reasonErr || amount === null) return;
    try {
      const res = await change.mutateAsync({ id: entry.id, amount, remark: reason.trim() });
      toast({
        title: `${row.name}'s ${KIND_LABEL[entry.kind].toLowerCase()} changed to ${rupees(amount)}`,
        description: payrollLine(res.payrollUpdated, kind),
      });
      onClose();
    } catch (err) {
      toast({ title: "Could not change the amount", description: errorText(err), variant: "destructive" });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Pencil size={16} className={accent.icon} /> Change the amount
        </DialogTitle>
        <DialogDescription>
          {row.name} ({row.code}) · {periodLabel}
        </DialogDescription>
      </DialogHeader>
      <form
        className="min-w-0 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="space-y-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <KindChip kind={entry.kind} />
            <Money value={entry.amount} kind={entry.kind}>
              {signedRupees(signedAmount(entry.kind, entry.amount))}
            </Money>
          </div>
          <p className="break-words text-xs text-gray-700">{entry.remark}</p>
          <p className="text-[11px] text-muted-foreground">
            Added by {entry.createdBy ?? "—"} · {dateTime(entry.createdAt)}
          </p>
        </div>
        <AmountField
          value={amountText}
          onChange={setAmountText}
          error={tried || amountText.trim() !== "" ? amountErr : null}
          label="New amount (₹)"
          hint={`The type stays ${KIND_LABEL[entry.kind]}: to switch it, remove this one and add a new one.`}
          testId="excess-change-amount"
          autoFocus
        />
        {preview && !amountErr && (
          <p className="text-xs font-semibold text-gray-800" data-testid="excess-change-preview">
            {preview}
          </p>
        )}
        <RemarkField
          value={reason}
          onChange={setReason}
          error={tried || reason.trim().length > 500 ? reasonErr : null}
          label="Reason for the change"
          placeholder="e.g. Corrected after MD approval"
          testId="excess-change-reason"
        />
        <DialogFooter className={cn("gap-2", STICKY_FOOTER)}>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            className={cn("gap-2", accent.solid)}
            disabled={saving}
            data-testid="excess-change-save"
          >
            <BusyIcon busy={saving} icon={CheckCircle2} /> Save the change
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// ── Remove ────────────────────────────────────────────────────────────────────

/** Remove one entry or several, with one reason for all of them. */
export function RemoveEntriesDialog({
  targets,
  kind,
  onClose,
  onRemoved,
}: {
  /** The entries to remove; empty / null = closed. */
  targets: EntryWithRow[] | null;
  /** Staff or production: which payroll's endpoint removes them. */
  kind: PayrollKind;
  onClose: () => void;
  /** After a removal: the ids that are gone (the page drops them from its selection). */
  onRemoved?: (ids: number[]) => void;
}) {
  const open = !!targets && targets.length > 0;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={cn(DIALOG_CLASS, "max-w-md")} data-testid="excess-remove-dialog">
        {open && <RemoveForm targets={targets} kind={kind} onClose={onClose} onRemoved={onRemoved} />}
      </DialogContent>
    </Dialog>
  );
}

function RemoveForm({
  targets,
  kind,
  onClose,
  onRemoved,
}: {
  targets: EntryWithRow[];
  kind: PayrollKind;
  onClose: () => void;
  onRemoved?: (ids: number[]) => void;
}) {
  const { toast } = useToast();
  const { remove } = usePayrollExcessActions(kind);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const reasonErr = remarkError(reason, "reason");
  const saving = remove.isPending;
  const one = targets.length === 1;
  const excessBack = targets.filter((t) => t.entry.kind === "excess").reduce((s, t) => s + t.entry.amount, 0);
  const detectionBack = targets.filter((t) => t.entry.kind === "detection").reduce((s, t) => s + t.entry.amount, 0);
  const employees = new Set(targets.map((t) => t.row.employeeId)).size;

  const save = async () => {
    setTried(true);
    if (reasonErr) return;
    const ids = targets.map((t) => t.entry.id);
    try {
      const res = await remove.mutateAsync({ entryIds: ids, remark: reason.trim() });
      toast({
        title: one
          ? `${targets[0].row.name}'s ${KIND_LABEL[targets[0].entry.kind].toLowerCase()} of ${rupees(targets[0].entry.amount)} removed`
          : `${plural(res.removed, "entry", "entries")} removed`,
        description: payrollLine(res.payrollUpdated, kind),
      });
      onRemoved?.(ids);
      onClose();
    } catch (err) {
      toast({
        title: one ? "Could not remove the entry" : "Could not remove the entries",
        description: errorText(err),
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Trash2 size={16} className="text-rose-600" />
          {one ? "Remove this entry" : `Remove ${targets.length} entries`}
        </DialogTitle>
        <DialogDescription>
          {one
            ? `${targets[0].row.name}'s earned salary goes back to what it was without it.`
            : `From ${plural(employees, "employee")}: their earned salary goes back to what it was without these entries.`}{" "}
          The removal stays in the history.
        </DialogDescription>
      </DialogHeader>
      <form
        className="min-w-0 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ul
          className="max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white"
          data-testid="excess-remove-list"
        >
          {targets.map(({ entry, row }) => (
            <li key={entry.id} className="space-y-0.5 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate font-semibold text-gray-900">
                  {row.name} <span className="font-mono text-xs font-normal text-muted-foreground">{row.code}</span>
                </span>
                <span className="flex items-center gap-2">
                  <KindChip kind={entry.kind} />
                  <Money value={entry.amount} kind={entry.kind}>
                    {signedRupees(signedAmount(entry.kind, entry.amount))}
                  </Money>
                </span>
              </div>
              <p className="break-words text-xs text-muted-foreground">{entry.remark}</p>
            </li>
          ))}
        </ul>
        {!one && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700" data-testid="excess-remove-totals">
            {excessBack > 0 && (
              <span className="inline-flex items-center gap-1">
                <PlusCircle size={12} className="text-emerald-600" /> Excess taken back: {rupees(excessBack)}
              </span>
            )}
            {detectionBack > 0 && (
              <span className="inline-flex items-center gap-1">
                <MinusCircle size={12} className="text-rose-600" /> Detection given back: {rupees(detectionBack)}
              </span>
            )}
          </p>
        )}
        <RemarkField
          value={reason}
          onChange={setReason}
          error={tried || reason.trim().length > 500 ? reasonErr : null}
          label={one ? "Reason for removing it" : "Reason for removing them"}
          placeholder="e.g. Added by mistake"
          testId="excess-remove-reason"
        />
        <DialogFooter className={cn("gap-2", STICKY_FOOTER)}>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="gap-2 border-0 bg-none bg-rose-600 text-white hover:bg-rose-700"
            disabled={saving}
            data-testid="excess-remove-save"
          >
            <BusyIcon busy={saving} icon={Trash2} />
            {one ? "Remove the entry" : `Remove ${targets.length} entries`}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
