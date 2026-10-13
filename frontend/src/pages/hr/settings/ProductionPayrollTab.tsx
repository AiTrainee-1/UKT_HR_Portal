import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, CalendarRange, Factory, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  getPayrollSettingsQueryKey,
  getProductionCyclesQueryKey,
  getProductionNextPeriodQueryKey,
  getProductionPeriodsQueryKey,
  useListShifts,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type PayCycle,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { PRODUCTION_SUB_TAB_OF, type ProductionPayrollSubTab } from "./ProductionPayrollTab.meta";
import { addressSetting, saveErrorText, useDraft, useSubTabFromAddress, type Draft } from "./payroll/form";
import { dayOf } from "./payroll/preview";
import { BranchNotice } from "./payroll/ui";
import { CyclePanel } from "./production-payroll/CyclePanel";
import { CYCLE_INFO, CYCLES } from "./production-payroll/cycles";
import { LatePanel } from "./production-payroll/LatePanel";
import { ProductionOverview } from "./production-payroll/ProductionOverview";
import { ShiftPanel } from "./production-payroll/ShiftPanel";
import {
  cyclePayload,
  latePayload,
  ownLateRules,
  savedProduction,
  sharedLatePayload,
  type CycleForm,
  type ProductionPayload,
} from "./production-payroll/sections";

const SUB_TABS: { value: ProductionPayrollSubTab; label: string; icon: ReactNode }[] = [
  { value: "weekly", label: "Weekly", icon: <CalendarDays size={13} /> },
  { value: "biweekly", label: "BiWeekly", icon: <CalendarRange size={13} /> },
  { value: "monthly", label: "Monthly", icon: <Factory size={13} /> },
  { value: "late", label: "Late Detection", icon: <AlertTriangle size={13} /> },
  { value: "shift", label: "Attendance & Shift", icon: <UserCheck size={13} /> },
];

type Saving = PayCycle | "late";

/**
 * Settings -> Production Payroll. One sub-tab per pay cycle (Weekly, BiWeekly, Monthly: each a saved group with its own
 * Save button sending only that cycle's `prodCycles` entry), the global late detection (its own Save button: the
 * switch and the attendance mode), and a read-only sub-tab that says where shifts earned, pay and PF / ESI really
 * come from. Saving one group never resets another's unsaved edits.
 */
export default function ProductionPayrollTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdatePayrollSettings();
  const { data: settings, isLoading, isError, refetch } = usePayrollSettings();

  const saved = useMemo(() => savedProduction(settings), [settings]);
  const weekly = useDraft(saved.cycles.weekly);
  const biweekly = useDraft(saved.cycles.biweekly);
  const monthly = useDraft(saved.cycles.monthly);
  const drafts: Record<PayCycle, Draft<CycleForm>> = { weekly, biweekly, monthly };
  const late = useDraft(saved.late);

  const [subTab, setSubTab] = useState<ProductionPayrollSubTab>(
    () => PRODUCTION_SUB_TAB_OF[addressSetting()] ?? "weekly",
  );
  useSubTabFromAddress(PRODUCTION_SUB_TAB_OF, setSubTab);

  const [saving, setSaving] = useState<Saving | null>(null);
  const branchLogin = settings?.companyWideRulesEditable === false;
  const today = useMemo(() => dayOf(new Date()), []);
  const shifts = useListShifts();

  const keepSaved = (fresh: PayrollSettingsItem) => queryClient.setQueryData(getPayrollSettingsQueryKey(), fresh);

  /** The cycle's pages and the "with the saved settings" line must not show the old rule for 30 s after a save. */
  const refreshCycle = (cycle: PayCycle) => {
    void queryClient.invalidateQueries({ queryKey: getProductionNextPeriodQueryKey(cycle) });
    void queryClient.invalidateQueries({ queryKey: getProductionPeriodsQueryKey(cycle) });
    void queryClient.invalidateQueries({ queryKey: getProductionCyclesQueryKey() });
  };

  const runSave = async (
    group: Saving,
    payload: ProductionPayload,
    done: (fresh: PayrollSettingsItem) => void,
    ok: { title: string; description: string },
    failTitle: string,
  ) => {
    setSaving(group);
    try {
      // The hook types prodCycles as the server answers it (every cycle, every key); a save sends the patch shape.
      const fresh = await update.mutateAsync(payload as Partial<PayrollSettingsItem>);
      keepSaved(fresh);
      done(fresh);
      if (group !== "late") refreshCycle(group);
      toast(ok);
    } catch (err) {
      toast({ title: failTitle, description: saveErrorText(err), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const saveCycle = (cycle: PayCycle) => {
    const draft = drafts[cycle];
    const label = CYCLE_INFO[cycle].label;
    return runSave(
      cycle,
      cyclePayload(cycle, draft.form, draft.changed),
      () => draft.discard(),
      {
        title: `${label} settings saved`,
        description: `The next period generated on the ${label} payroll page follows them; periods already generated keep their dates and deductions.`,
      },
      `Failed to save ${label} settings`,
    );
  };

  /** Hands the cycle's late rules back to the shared ones; the form then shows those (unsaved late edits are dropped). */
  const revertToSharedRules = (cycle: PayCycle) => {
    const draft = drafts[cycle];
    const label = CYCLE_INFO[cycle].label;
    return runSave(
      cycle,
      sharedLatePayload(cycle),
      (fresh) => {
        const now = savedProduction(fresh).cycles[cycle];
        draft.set("lateFreeAllowance", now.lateFreeAllowance);
        draft.set("lateSlabs", now.lateSlabs);
      },
      {
        title: `${label} uses the shared late rules again`,
        description: `${label} payslips generated from now on follow the shared production allowance and slabs.`,
      },
      `Failed to change the ${label} late rules`,
    );
  };

  const dirtyOf = (tab: ProductionPayrollSubTab): boolean =>
    tab === "late" ? late.dirty : tab === "shift" ? false : drafts[tab].dirty;
  const unsavedElsewhere = SUB_TABS.filter((t) => t.value !== subTab && dirtyOf(t.value)).map((t) => t.label);

  return (
    <div className="space-y-4">
      {branchLogin && (
        <BranchNotice>
          You are signed in to a branch. What you save on this tab is kept apart from the company values: each cycle's
          pay period is used when you generate that cycle's production payroll, and the late rules apply to your
          branch's employees. The latest generated period that a cycle's next period continues from is company-wide, so
          it cannot be shown here.
        </BranchNotice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          items={SUB_TABS}
          value={subTab}
          onChange={(v) => setSubTab(v as ProductionPayrollSubTab)}
          baseColor="#0f172a"
          pillBg="#f1f5f9"
        />
        {unsavedElsewhere.length > 0 && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
            Not saved yet: {unsavedElsewhere.join(", ")}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3" data-testid="production-payroll-settings-loading">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : isError || !settings ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800">
          Could not load the production payroll settings.
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <ProductionOverview settings={settings} />

          {CYCLES.map(
            (cycle) =>
              subTab === cycle && (
                <CyclePanel
                  key={cycle}
                  cycle={cycle}
                  draft={drafts[cycle]}
                  saved={saved.cycles[cycle]}
                  ownRules={ownLateRules(settings, cycle)}
                  shared={{
                    allowance: settings.prodLateFreeAllowance ?? 3,
                    slabCount: (settings.prodLateDeductionSlabs ?? []).length,
                  }}
                  branchLogin={branchLogin}
                  today={today}
                  readOnly={readOnly}
                  saving={saving === cycle}
                  busy={saving !== null}
                  onSave={() => saveCycle(cycle)}
                  onUseShared={() => revertToSharedRules(cycle)}
                />
              ),
          )}

          {subTab === "late" && (
            <LatePanel
              draft={late}
              saved={saved.late}
              settings={settings}
              shifts={shifts.data}
              branchLogin={branchLogin}
              readOnly={readOnly}
              saving={saving === "late"}
              busy={saving !== null}
              onSave={() =>
                runSave(
                  "late",
                  latePayload(late.form),
                  () => late.discard(),
                  {
                    title: "Production Late Detection saved",
                    description:
                      "Applies the next time a production period is generated on any cycle; payslips already generated keep their late deduction until their period is generated again.",
                  },
                  "Failed to save Production Late Detection",
                )
              }
            />
          )}

          {subTab === "shift" && (
            <ShiftPanel
              settings={settings}
              shifts={shifts.data}
              shiftsLoading={shifts.isLoading}
              shiftsError={shifts.isError}
            />
          )}
        </>
      )}
    </div>
  );
}
