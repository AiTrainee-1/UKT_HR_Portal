import { useMemo } from "react";
import { Link } from "wouter";
import { AlertTriangle, Clock, ExternalLink, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useFactoryEmployees, type FactoryEmployee, type FactoryShiftsResult } from "@/lib/api-client/custom-hooks";
import { Chip } from "../account-management/parts";
import { employees, longDay } from "./logic";
import { AMBER_CHIP, CATEGORY_CHIP, LoadError, ViewOnlyNote } from "./parts";

type Props = {
  data: FactoryShiftsResult | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  canManage: boolean;
  onAssign: (rows: FactoryEmployee[], shiftId?: number) => void;
  onRemove: (people: { id: number; name: string }[]) => void;
};

/**
 * Every existing shift with the factory employees on it, and who is on none. Here people are only put on a shift or
 * taken off one; shifts themselves are created and changed on Manage Shifts (owner 2026-11-20).
 */
export function ShiftsSection({ data, loading, failed, onRetry, canManage, onAssign, onRemove }: Props) {
  // the rows of the active factory employees (the assign dialog works on them)
  const pool = useFactoryEmployees({ status: "active" });
  const byId = useMemo(() => new Map((pool.data?.employees ?? []).map((r) => [r.id, r])), [pool.data]);
  const shifts = data?.shifts ?? [];
  const noShift = data?.noShift ?? [];
  const groups = (["staff", "production"] as const)
    .map((type) => ({ type, items: shifts.filter((s) => s.shiftType === type) }))
    .filter((g) => g.items.length > 0);
  const noShiftRows = noShift.map((p) => byId.get(p.id)).filter((r): r is FactoryEmployee => !!r);

  return (
    <div className="space-y-4" data-testid="fe-shifts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Put factory employees on a shift or take them off one. A staff shift is for Staff Payroll employees, a
          production shift for Production Payroll ones.
        </p>
        <Link
          href="/hr/shifts"
          className="inline-flex items-center gap-1 text-sm font-semibold text-sky-700 hover:underline"
          data-testid="fe-shifts-manage-link"
        >
          <ExternalLink size={14} /> Create or edit shifts in Manage Shifts
        </Link>
      </div>
      {!canManage && (
        <ViewOnlyNote>
          You can see who is on which shift; changing it needs edit rights on Factory Employees.
        </ViewOnlyNote>
      )}

      {noShift.length > 0 && (
        <div
          className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
          data-testid="fe-shifts-missing"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle size={15} /> {employees(noShift.length)} {noShift.length === 1 ? "has" : "have"} no shift,
              so attendance has no hours to judge them by.
            </p>
            {canManage && (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => onAssign(noShiftRows)}
                disabled={noShiftRows.length === 0}
                data-testid="fe-shifts-assign-missing"
              >
                <UserPlus size={14} /> Assign a shift
              </Button>
            )}
          </div>
          <p className="text-xs text-amber-800">{noShift.map((p) => `${p.name} (${p.code})`).join(", ")}</p>
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : failed ? (
        <LoadError what="the shifts" onRetry={onRetry} />
      ) : groups.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground" data-testid="fe-shifts-empty">
            There are no shifts yet. They are created on{" "}
            <Link href="/hr/shifts" className="font-semibold text-sky-700 hover:underline">
              Manage Shifts
            </Link>
            .
          </CardContent>
        </Card>
      ) : (
        groups.map((g) => (
          <section key={g.type} className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
              {g.type === "staff" ? "Staff shifts" : "Production shifts"}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.items.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-col rounded-2xl border bg-white p-4"
                  data-testid={`fe-shift-card-${s.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-bold text-gray-900">{s.name}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-sm text-gray-700">
                        <Clock size={13} className="text-gray-400" /> {s.startTime}-{s.endTime}
                        {s.graceMinutes != null && (
                          <span className="text-xs text-gray-500"> · grace {s.graceMinutes} min</span>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Chip className={CATEGORY_CHIP[s.shiftType]}>
                        {s.shiftType === "staff" ? "Staff" : "Production"}
                      </Chip>
                      {s.genderRule !== "all" && <Chip className={AMBER_CHIP}>{s.genderRule} only</Chip>}
                    </div>
                  </div>
                  <p className="mt-2 text-xs font-semibold text-gray-600" data-testid={`fe-shift-count-${s.id}`}>
                    {employees(s.employees.length)} from this page
                  </p>
                  {s.employees.length > 0 && (
                    <ul className="mt-1.5 max-h-56 divide-y overflow-y-auto rounded-xl border">
                      {s.employees.map((m) => (
                        <li
                          key={m.assignmentId}
                          className="flex items-center justify-between gap-2 px-3 py-1.5"
                          data-testid={`fe-shift-member-${m.code}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-gray-900">{m.name}</span>
                            <span className="block text-[11px] text-gray-500">
                              {m.code}
                              {m.effectiveFrom && ` · since ${longDay(m.effectiveFrom)}`}
                              {m.effectiveTo && (
                                <span className="font-semibold text-amber-700"> · until {longDay(m.effectiveTo)}</span>
                              )}
                            </span>
                          </span>
                          {canManage && !m.effectiveTo && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 shrink-0 gap-1 px-2 text-xs text-red-700"
                              onClick={() => onRemove([{ id: m.id, name: m.name }])}
                              aria-label={`Take ${m.name} off ${s.name}`}
                              data-testid={`fe-shift-remove-${m.code}`}
                            >
                              <UserMinus size={12} /> Take off
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage && (
                    <div className="mt-auto flex justify-end pt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2 text-xs"
                        onClick={() => onAssign([], s.id)}
                        aria-label={`Assign employees to ${s.name}`}
                        data-testid={`fe-shift-assign-${s.id}`}
                      >
                        <UserPlus size={13} /> Assign people
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
