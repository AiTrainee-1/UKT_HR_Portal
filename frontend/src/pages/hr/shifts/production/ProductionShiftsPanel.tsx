import { useState } from "react";
import { Link } from "wouter";
import {
  ArrowUpRight,
  Coffee,
  Pencil,
  Plus,
  Power,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useDeleteSpecialShift,
  useProductionShifts,
  useSwitchSpecialShift,
  type SpecialProductionShift,
} from "@/lib/api-client/custom-hooks";
import { Gate } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { prettyDate } from "@/pages/hr/settings/compensation/form";
import ProductionShiftCard from "./ProductionShiftCard";
import SpecialAssignDialog from "./SpecialAssignDialog";
import SpecialAssignments from "./SpecialAssignments";
import SpecialShiftDialog from "./SpecialShiftDialog";

export const PRODUCTION_SETTINGS_PATH = "/hr/settings?tab=production_shifts";

function IconButton({
  label,
  onClick,
  children,
  danger = false,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors",
        danger ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-gray-100 hover:text-gray-700",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The Production shifts of Manage Shifts (owner 2026-11-16: "the shifts configured in the Production Shift Settings page
 * should automatically appear in Manage Shifts"). The DEFAULT shifts are the groups of Settings -> Production Shifts,
 * shown with their timings, detection timings and Earned Shift tables and edited in Settings only: every production worker
 * is on them, nobody has to be assigned. Below them the SPECIAL shifts: complete shifts of their own for chosen workers,
 * made, changed and assigned here. Staff shifts are not part of this.
 */
export default function ProductionShiftsPanel() {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useProductionShifts();
  const switchShift = useSwitchSpecialShift();
  const removeShift = useDeleteSpecialShift();
  const [editing, setEditing] = useState<SpecialProductionShift | "new" | null>(null);
  const [assigning, setAssigning] = useState<SpecialProductionShift | null>(null);
  const [deleting, setDeleting] = useState<SpecialProductionShift | null>(null);
  // the workers of each special shift are listed unless HR folds them away
  const [foldedPeople, setFoldedPeople] = useState<Set<number>>(new Set());

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="production-shifts-loading">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-72 rounded-2xl" />
        ))}
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Card
        className="border-0 p-6 text-center text-sm text-muted-foreground shadow-sm"
        data-testid="production-shifts-error"
      >
        The production shifts could not be loaded.{" "}
        <button type="button" className="font-semibold text-primary underline" onClick={() => void refetch()}>
          Try again
        </button>
      </Card>
    );
  }

  const grace = data.graceMinutes;
  const onSpecial = data.roster.onSpecialToday;
  const toggle = async (s: SpecialProductionShift) => {
    try {
      await switchShift.mutateAsync({ id: s.id, enabled: !s.enabled });
      toast({ title: s.enabled ? `${s.label} switched off` : `${s.label} switched on` });
    } catch (e) {
      toast({ title: "Not changed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      // one that had workers on it is deleted with them taken off it (the dialog said so)
      const res = await removeShift.mutateAsync({ id: deleting.id, force: deleting.everAssigned });
      toast({ title: `${deleting.label} deleted` });
      res.warnings?.forEach((w) => toast({ title: "Note", description: w }));
    } catch (e) {
      toast({ title: "Not deleted", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDeleting(null);
    }
  };
  const togglePeople = (id: number) =>
    setFoldedPeople((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-5" data-testid="production-shifts-panel">
      {/* where these come from */}
      <Card className="border-0 p-4 shadow-sm" data-testid="production-shifts-intro">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1 text-[13px] leading-relaxed text-slate-600">
            <p className="text-sm font-bold text-slate-900">Production shifts</p>
            <p>
              The <b className="text-slate-800">default shifts</b> are the ones set in Settings, Production Shifts. They
              apply to every production worker automatically, so nobody has to be assigned. A{" "}
              <b className="text-slate-800">special shift</b> is for chosen workers only: on its days they are judged
              and paid by it instead.
            </p>
            <p className="text-xs" data-testid="production-shifts-status">
              {data.enabled
                ? data.effectiveFrom
                  ? `Rules on from ${prettyDate(data.effectiveFrom)} · grace ${grace} min.`
                  : `Rules on · grace ${grace} min.`
                : "The rules are switched off in Settings: every production day uses the old calculation."}{" "}
              {data.roster.production} production workers · {onSpecial} on a special shift today.
            </p>
          </div>
          <Link
            href={PRODUCTION_SETTINGS_PATH}
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-slate-900"
            data-testid="production-shifts-settings-link"
          >
            Edit defaults in Settings <ArrowUpRight size={13} />
          </Link>
        </div>
      </Card>

      {/* the defaults, from Settings */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-gray-900">Default shifts · from Settings</h3>
        {data.defaults.length === 0 ? (
          <Card className="border-0 p-5 text-sm text-muted-foreground shadow-sm">
            No default production shift is set up yet. Add them in Settings, Production Shifts.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {data.defaults.map((g) => (
              <ProductionShiftCard
                key={g.id}
                group={g}
                graceMinutes={grace}
                testId={`production-default-${g.id}`}
                footer={
                  <p className="flex items-center gap-1.5 text-xs text-gray-600">
                    <Users size={13} />
                    Every production worker
                    {onSpecial > 0 ? `, except ${onSpecial} on a special shift today` : ""}. Edit it in Settings.
                  </p>
                }
              />
            ))}
          </div>
        )}
        {data.breaks.length > 0 && (
          <p
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600"
            data-testid="production-breaks"
          >
            <span className="flex items-center gap-1 font-semibold text-slate-800">
              <Coffee size={13} /> Unpaid breaks, every shift:
            </span>
            {data.breaks.map((b) => (
              <span key={b.id} className="tabular-nums">
                {b.label || "Break"} {b.startTime}–{b.endTime}
              </span>
            ))}
          </p>
        )}
      </section>

      {/* special shifts */}
      <section className="space-y-3" data-testid="production-special-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
            <Sparkles size={14} className="text-violet-600" /> Special shifts
          </h3>
          <Gate k="shifts.production_special">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setEditing("new")}
              data-testid="production-special-new"
            >
              <Plus size={14} /> New special shift
            </Button>
          </Gate>
        </div>
        {data.special.length === 0 ? (
          <Card className="border-0 p-5 text-sm text-muted-foreground shadow-sm" data-testid="production-special-empty">
            No special shift yet. Make one when a few workers need their own hours and Earned Shift table.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {data.special.map((s) => {
              const open = !foldedPeople.has(s.id);
              return (
                <ProductionShiftCard
                  key={s.id}
                  group={s}
                  graceMinutes={grace}
                  special
                  testId={`production-special-${s.id}`}
                  actions={
                    <Gate k="shifts.production_special">
                      <IconButton
                        label={`Change ${s.label}`}
                        onClick={() => setEditing(s)}
                        testId={`special-edit-${s.id}`}
                      >
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton
                        label={s.enabled ? `Switch off ${s.label}` : `Switch on ${s.label}`}
                        onClick={() => void toggle(s)}
                        testId={`special-toggle-${s.id}`}
                      >
                        <Power size={15} className={s.enabled ? "" : "text-emerald-600"} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${s.label}`}
                        onClick={() => setDeleting(s)}
                        danger
                        testId={`special-delete-${s.id}`}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </Gate>
                  }
                  footer={
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => togglePeople(s.id)}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-primary"
                          aria-expanded={open}
                          data-testid={`special-people-${s.id}`}
                        >
                          <Users size={13} />
                          {s.activeCount === 0 ? "Nobody on it now" : `${s.activeCount} on it now`}
                          {s.assignments.length > s.activeCount ? ` · ${s.assignments.length} in all` : ""}
                        </button>
                        <Gate k="shifts.production_special">
                          <button
                            type="button"
                            onClick={() => setAssigning(s)}
                            disabled={!s.enabled}
                            title={
                              s.enabled ? "Choose who works this shift" : "Switch it on before putting anyone on it"
                            }
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                            data-testid={`special-assign-${s.id}`}
                          >
                            <UserPlus size={13} /> Put workers on it
                          </button>
                        </Gate>
                      </div>
                      {open && (
                        <SpecialAssignments
                          rows={s.assignments}
                          today={data.today}
                          testId={`special-assignments-${s.id}`}
                        />
                      )}
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {editing && (
        <SpecialShiftDialog
          key={editing === "new" ? "new" : editing.id}
          open
          onClose={() => setEditing(null)}
          editing={editing === "new" ? null : editing}
          graceMinutes={grace}
        />
      )}
      {assigning && (
        <SpecialAssignDialog
          key={assigning.id}
          open
          onClose={() => setAssigning(null)}
          shift={data.special.find((x) => x.id === assigning.id) ?? assigning}
          today={data.today}
        />
      )}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent data-testid="special-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert size={18} className="text-amber-500" />
              Delete {deleting?.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.everAssigned
                ? `${deleting.assignments.length} assignment${deleting.assignments.length === 1 ? " goes" : "s go"} with it: its workers are taken off it and are back on the default production shifts. The days they worked on it are worked out again with the default shifts; a production payroll already generated for those days needs Generate again, a Paid one never changes. To keep those days as they are, switch it off instead.`
                : "Nobody was ever on it, so it is removed for good."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => void confirmDelete()}
              data-testid="special-delete-confirm"
            >
              {deleting?.everAssigned ? "Delete and take its workers off" : "Delete special shift"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The special shifts' assignments for the Assignments tab (Production): every special shift together. */
export function ProductionAssignmentsView() {
  const { data, isLoading } = useProductionShifts();
  if (isLoading || !data) return <Skeleton className="h-40 rounded-2xl" />;
  const rows = data.special.flatMap((s) => s.assignments);
  const names = Object.fromEntries(data.special.map((s) => [s.id, s.label]));
  return (
    <div className="space-y-3" data-testid="production-assignments-view">
      <Card className="border-0 p-4 text-[13px] leading-relaxed text-slate-600 shadow-sm">
        All {data.roster.production} production workers are on the default production shifts from Settings
        automatically. Only special shifts are assigned to people; they are listed here.{" "}
        <Link href={PRODUCTION_SETTINGS_PATH} className="font-semibold text-primary underline">
          Default shifts in Settings
        </Link>
      </Card>
      <SpecialAssignments rows={rows} today={data.today} showShift shiftNames={names} testId="production-assignments" />
    </div>
  );
}
