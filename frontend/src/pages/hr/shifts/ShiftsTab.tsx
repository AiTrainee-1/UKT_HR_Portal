import { useMemo, useState, type ReactNode } from "react";
import { Factory, Info, Plus, TriangleAlert } from "lucide-react";
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
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useProductionShifts,
  useRemoveShiftTemplate,
  useSaveShiftTemplate,
  type ShiftItem,
  type ShiftType,
} from "@/lib/api-client/custom-hooks";
import { TypeChips } from "./AssignmentsTab";
import ProductionShiftsPanel from "./production/ProductionShiftsPanel";
import ShiftCard from "./ShiftCard";
import { pluralize, type TypeFilter } from "./shift-logic";

function Note({ tone, children }: { tone: "blue" | "green" | "amber"; children: ReactNode }) {
  const cls = {
    blue: "border-blue-100 bg-blue-50/70 text-blue-900",
    green: "border-emerald-100 bg-emerald-50/70 text-emerald-900",
    amber: "border-amber-100 bg-amber-50/70 text-amber-900",
  }[tone];
  return (
    <p className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${cls}`}>
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The shift templates. A shift can be edited, disabled (it keeps its people and history but cannot be given to anyone
 * new) or deleted (only while nobody has ever been on it: deleting a shift would erase the shift attendance and payroll
 * used for the days people worked it).
 *
 * Production (owner 2026-11-16) is not templates any more: the default production shifts are the groups of Settings ->
 * Production Shifts and special shifts are made here (ProductionShiftsPanel). `shifts` are the staff templates; the old
 * Production Shift template is retired (kept in the database for the days before the rules started).
 */
export default function ShiftsTab({
  shifts,
  loading,
  onCreate,
  onEdit,
  onAssign,
  onViewPeople,
}: {
  shifts: ShiftItem[];
  loading: boolean;
  onCreate: (type: ShiftType) => void;
  onEdit: (s: ShiftItem) => void;
  onAssign: (s: ShiftItem) => void;
  onViewPeople: (s: ShiftItem) => void;
}) {
  const { toast } = useToast();
  const save = useSaveShiftTemplate();
  const remove = useRemoveShiftTemplate();
  const production = useProductionShifts();
  const [type, setType] = useState<TypeFilter>("all");
  const [deleting, setDeleting] = useState<ShiftItem | null>(null);

  const staffShifts = useMemo(() => shifts.filter((s) => s.shiftType === "staff"), [shifts]);
  const productionCount = (production.data?.defaults.length ?? 0) + (production.data?.special.length ?? 0);
  const counts: Record<TypeFilter, number> = {
    all: staffShifts.length + productionCount,
    staff: staffShifts.length,
    production: productionCount,
  };
  const list = type === "production" ? [] : staffShifts;

  const toggleActive = async (s: ShiftItem) => {
    try {
      await save.mutateAsync({ id: s.id, data: { isActive: !s.isActive } });
      toast({ title: s.isActive ? `${s.name} disabled` : `${s.name} enabled` });
    } catch (e) {
      toast({
        title: "Could not change the shift",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast({ title: `${deleting.name} deleted` });
    } catch (e) {
      toast({
        title: "The shift was not deleted",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDeleting(null);
    }
  };

  const inUse = (deleting?.assignedCount ?? 0) > 0;

  return (
    <div className="space-y-4" data-testid="shifts-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TypeChips value={type} onChange={setType} counts={counts} />
      </div>

      {type === "staff" && (
        <Note tone="green">
          Staff employees are paid <b>monthly</b>. A staff shift can go to individual employees, whole departments or
          designations, with anyone left out that you choose.
        </Note>
      )}

      {type === "production" ? null : loading ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-52 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center border-0 py-14 text-center shadow-sm">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-500">
            <Factory size={22} />
          </span>
          <p className="font-semibold text-gray-700">No staff shifts yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A shift is a set of working hours. Create one, then assign people to it.
          </p>
          <Button className="mt-4 gap-2" onClick={() => onCreate("staff")}>
            <Plus size={14} /> New Shift
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {list.map((s) => (
            <ShiftCard
              key={s.id}
              shift={s}
              onAssign={() => onAssign(s)}
              onEdit={() => onEdit(s)}
              onToggleActive={() => void toggleActive(s)}
              onDelete={() => setDeleting(s)}
              onViewPeople={() => onViewPeople(s)}
            />
          ))}
        </div>
      )}

      {/* production: the Settings shifts and the special shifts (on All, after the staff shifts) */}
      {(type === "production" || (type === "all" && productionCount > 0)) && (
        <div className={type === "all" ? "space-y-2 border-t pt-4" : undefined}>
          <ProductionShiftsPanel />
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent data-testid="delete-shift-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert size={18} className="text-amber-500" />
              {inUse ? `${deleting?.name} is in use` : `Delete ${deleting?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inUse ? (
                <>
                  {pluralize(deleting?.assignedCount ?? 0, "employee")} {deleting?.assignedCount === 1 ? "is" : "are"}{" "}
                  on this shift. Move them to another shift first. To stop it being used for anyone new, disable it
                  instead: it keeps its history.
                </>
              ) : (
                <>
                  This removes the shift for good. A shift that people have worked in the past cannot be deleted,
                  because attendance and payroll for those days depend on it. Disable it instead.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            {!inUse && (
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700"
                onClick={() => void confirmDelete()}
                data-testid="delete-shift-confirm"
              >
                Delete shift
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
