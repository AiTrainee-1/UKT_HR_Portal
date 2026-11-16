import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useSaveSpecialShift,
  type ProductionShiftAppliesOn,
  type SpecialProductionShift,
  type SpecialShiftInput,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { DAYS_LABEL } from "./production-shift-logic";

type Row = { key: number; id?: number; label: string; outTime: string; outNextDay: boolean; shiftValue: string };

let nextKey = 1;
const newRow = (over: Partial<Row> = {}): Row => ({
  key: nextKey++,
  label: "",
  outTime: "",
  outNextDay: false,
  shiftValue: "",
  ...over,
});

/** A new special shift starts as one ordinary day: 08:00 to 17:00, leave at 17:00 = 1.00 shift. */
function initial(editing: SpecialProductionShift | null) {
  if (!editing) {
    return {
      label: "",
      appliesOn: "mon_sat" as ProductionShiftAppliesOn,
      startTime: "08:00",
      mainOutTime: "17:00",
      mainOutNextDay: false,
      enabled: true,
      rows: [newRow({ outTime: "17:00", shiftValue: "1.00" })],
    };
  }
  return {
    label: editing.label,
    appliesOn: editing.appliesOn,
    startTime: editing.startTime,
    mainOutTime: editing.mainOutTime ?? "",
    mainOutNextDay: editing.mainOutNextDay,
    enabled: editing.enabled,
    rows: editing.rules
      .filter((r) => r.enabled)
      .map((r) =>
        newRow({
          id: r.id,
          label: r.label,
          outTime: r.outTime,
          outNextDay: r.outNextDay,
          shiftValue: Number(r.shiftValue).toFixed(2),
        }),
      ),
  };
}

/** What can be told before the server checks the whole table (it checks everything Settings checks). */
function problem(form: ReturnType<typeof initial>): string | null {
  if (!form.label.trim()) return "Give the special shift a name.";
  if (!form.startTime) return "Set the start time.";
  if (form.rows.length === 0) return "Add at least one Earned Shift row.";
  for (const [i, r] of form.rows.entries()) {
    if (!r.outTime) return `Row ${i + 1}: set the leaving time.`;
    const v = Number(r.shiftValue);
    if (r.shiftValue.trim() === "" || !Number.isFinite(v) || v <= 0 || v > 9.99)
      return `Row ${i + 1}: the shifts must be a number more than 0 and at most 9.99.`;
    if (Math.round(v * 100) !== v * 100) return `Row ${i + 1}: use at most two decimals.`;
  }
  return null;
}

/**
 * Make or change a special production shift (owner 2026-11-16): a complete shift of its own for chosen workers: its
 * name, the days it applies to, its start and standard departure (the detection timings follow from these and the rules'
 * grace) and its own Earned Shift table ("leave at this time = this many shifts"). The server checks it exactly like a
 * Settings group (rows in time order, values never going down, two rows on the same paid time ...) and says what to fix.
 */
export default function SpecialShiftDialog({
  open,
  onClose,
  editing,
  graceMinutes,
}: {
  open: boolean;
  onClose: () => void;
  editing: SpecialProductionShift | null;
  graceMinutes: number;
}) {
  const { toast } = useToast();
  const save = useSaveSpecialShift();
  const [form, setForm] = useState(() => initial(editing));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setRow = (key: number, patch: Partial<Row>) =>
    setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  const submit = async () => {
    const local = problem(form);
    if (local) {
      setError(local);
      return;
    }
    const data: SpecialShiftInput = {
      label: form.label.trim(),
      appliesOn: form.appliesOn,
      startTime: form.startTime,
      mainOutTime: form.mainOutTime || null,
      mainOutNextDay: !!form.mainOutTime && form.mainOutNextDay,
      enabled: form.enabled,
      rules: form.rows.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        label: r.label.trim(),
        outTime: r.outTime,
        outNextDay: r.outNextDay,
        shiftValue: Number(r.shiftValue),
        enabled: true,
      })),
    };
    try {
      const res = await save.mutateAsync({ id: editing?.id, data });
      toast({ title: editing ? `${data.label} saved` : `${data.label} created` });
      res.warnings?.forEach((w) => toast({ title: "Note", description: w }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The special shift was not saved.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="special-shift-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? `Change ${editing.label}` : "New special production shift"}</DialogTitle>
          <DialogDescription>
            For chosen workers only. On its days they are judged and paid by this shift instead of the default
            production shifts from Settings. A first punch up to the start + {graceMinutes} min is on time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-semibold text-gray-700">
              Name
              <Input
                value={form.label}
                onChange={(e) => set("label", e.target.value)}
                placeholder="e.g. Early loading 6-3"
                maxLength={80}
                autoFocus
                data-testid="special-name"
              />
            </label>
            <div className="space-y-1 text-xs font-semibold text-gray-700">
              Days
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Days">
                {(Object.keys(DAYS_LABEL) as ProductionShiftAppliesOn[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={form.appliesOn === d}
                    onClick={() => set("appliesOn", d)}
                    className={cn(
                      "h-9 rounded-lg border px-3 text-xs font-semibold",
                      form.appliesOn === d
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                    )}
                    data-testid={`special-days-${d}`}
                  >
                    {DAYS_LABEL[d]}
                  </button>
                ))}
              </div>
            </div>
            <label className="space-y-1 text-xs font-semibold text-gray-700">
              Start time
              <Input
                type="time"
                value={form.startTime}
                onChange={(e) => set("startTime", e.target.value)}
                data-testid="special-start"
              />
            </label>
            <div className="space-y-1 text-xs font-semibold text-gray-700">
              Standard departure (for the early-out check)
              <div className="flex items-center gap-3">
                <Input
                  type="time"
                  value={form.mainOutTime}
                  onChange={(e) => set("mainOutTime", e.target.value)}
                  className="flex-1"
                  data-testid="special-out"
                />
                <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
                  <Checkbox
                    checked={form.mainOutNextDay}
                    onCheckedChange={(v) => set("mainOutNextDay", v === true)}
                    data-testid="special-out-next-day"
                  />
                  Next day
                </label>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-gray-900">Earned Shift table</p>
                <p className="text-[11px] text-gray-500">
                  Leave at this time = this many shifts; between two rows it grows with the paid time (breaks are
                  unpaid). Rows in time order, shifts never going down.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1"
                onClick={() => set("rows", [...form.rows, newRow()])}
                data-testid="special-add-row"
              >
                <Plus size={13} /> Row
              </Button>
            </div>
            <div className="space-y-2" data-testid="special-rows">
              {form.rows.map((r, i) => (
                <div
                  key={r.key}
                  className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[auto_8rem_auto_6rem_1fr_auto]"
                >
                  <span className="w-5 text-right tabular-nums text-gray-400">{i + 1}</span>
                  <Input
                    type="time"
                    value={r.outTime}
                    onChange={(e) => setRow(r.key, { outTime: e.target.value })}
                    aria-label={`Row ${i + 1} leaving time`}
                    data-testid={`special-row-${i}-time`}
                  />
                  <label className="flex items-center gap-1 text-[11px] text-gray-600">
                    <Checkbox
                      checked={r.outNextDay}
                      onCheckedChange={(v) => setRow(r.key, { outNextDay: v === true })}
                      aria-label={`Row ${i + 1} next day`}
                    />
                    +1 day
                  </label>
                  <Input
                    inputMode="decimal"
                    value={r.shiftValue}
                    onChange={(e) => setRow(r.key, { shiftValue: e.target.value })}
                    placeholder="1.00"
                    aria-label={`Row ${i + 1} shifts`}
                    data-testid={`special-row-${i}-value`}
                  />
                  <Input
                    value={r.label}
                    onChange={(e) => setRow(r.key, { label: e.target.value })}
                    placeholder="Note (optional)"
                    className="col-span-4 sm:col-span-1"
                    aria-label={`Row ${i + 1} note`}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        "rows",
                        form.rows.filter((x) => x.key !== r.key),
                      )
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                    aria-label={`Remove row ${i + 1}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
            <span>
              <span className="block text-sm font-semibold text-gray-900">Switched on</span>
              <span className="block text-[11px] text-gray-500">
                Off: its workers are judged and paid by the default shifts until it is switched on again.
              </span>
            </span>
            <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} data-testid="special-enabled" />
          </label>

          {error && (
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              data-testid="special-error"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending} data-testid="special-save">
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create special shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
