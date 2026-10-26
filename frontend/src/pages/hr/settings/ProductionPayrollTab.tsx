import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CalendarRange, Factory, IndianRupee, LayoutList } from "lucide-react";
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
import { PayBonusPanel } from "./production-payroll/PayBonusPanel";
import { ProductionOverview } from "./production-payroll/ProductionOverview";
import { ShiftPanel } from "./production-payroll/ShiftPanel";
import {
  cyclePayload,
  payBonusPayload,
  savedProduction,
  type CycleForm,
  type ProductionPayload,
} from "./production-payroll/sections";

const SUB_TABS: { value: ProductionPayrollSubTab; label: string; icon: ReactNode }[] = [
  { value: "overview", label: "Overview", icon: <LayoutList size={13} /> },
  { value: "weekly", label: "Weekly", icon: <CalendarDays size={13} /> },
  { value: "biweekly", label: "BiWeekly", icon: <CalendarRange size={13} /> },
  { value: "monthly", label: "Monthly", icon: <Factory size={13} /> },
  { value: "payBonus", label: "Pay & Bonus", icon: <IndianRupee size={13} /> },
];

type Saving = PayCycle | "payBonus";

/**
 * Settings -> Production Payroll. An Overview (read-only: how a production payslip is worked out and where each part is
 * set), one sub-tab per pay cycle (Weekly, BiWeekly, Monthly: each a saved group with its own Save button sending only that
 * cycle's PERIOD keys of `prodCycles`) and Pay & Bonus (the rate suggested for new production employees and the
 * production statutory bonus, saved together, sending only what changed). What a late day costs a production worker is on
 * Late Detection -> Production. Saving one group never resets another's unsaved edits.
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
  const payBonus = useDraft(saved.payBonus);

  const [subTab, setSubTab] = useState<ProductionPayrollSubTab>(
    () => PRODUCTION_SUB_TAB_OF[addressSetting()] ?? "overview",
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
      if (group !== "payBonus") refreshCycle(group);
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
      cyclePayload(cycle, draft.form),
      () => draft.discard(),
      {
        title: `${label} settings saved`,
        description: `The next period generated on the ${label} payroll page follows them; periods already generated keep their dates and deductions.`,
      },
      `Failed to save ${label} settings`,
    );
  };

  const branchOnly = branchLogin ? " They apply to your branch's employees only." : "";
  const savePayBonus = () =>
    runSave(
      "payBonus",
      payBonusPayload(payBonus.form, payBonus.changed),
      () => payBonus.discard(),
      {
        title: "Pay & Bonus settings saved",
        description: `New production employees start from the suggested rate at once; the Bonus page's figures for production workers use the bonus values at once, and a bonus register already generated changes only when Generate is run again.${branchOnly}`,
      },
      "Failed to save Pay & Bonus settings",
    );

  const dirtyOf = (tab: ProductionPayrollSubTab): boolean =>
    tab === "overview" ? false : tab === "payBonus" ? payBonus.dirty : drafts[tab].dirty;
  const unsavedElsewhere = SUB_TABS.filter((t) => t.value !== subTab && dirtyOf(t.value)).map((t) => t.label);

  return (
    <div className="space-y-4">
      {branchLogin && (
        <BranchNotice>
          You are signed in to a branch. What you save on this tab is kept apart from the company values: each cycle's
          pay period is used when you generate that cycle's production payroll, and the suggested rate and the
          production bonus apply to your branch's employees. The latest generated period that a cycle's next period
          continues from is company-wide, so it cannot be shown here.
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
          {subTab === "overview" && (
            <>
              <ProductionOverview settings={settings} />
              <ShiftPanel shifts={shifts.data} shiftsLoading={shifts.isLoading} shiftsError={shifts.isError} />
            </>
          )}

          {CYCLES.map(
            (cycle) =>
              subTab === cycle && (
                <CyclePanel
                  key={cycle}
                  cycle={cycle}
                  draft={drafts[cycle]}
                  saved={saved.cycles[cycle]}
                  branchLogin={branchLogin}
                  today={today}
                  readOnly={readOnly}
                  saving={saving === cycle}
                  busy={saving !== null}
                  onSave={() => saveCycle(cycle)}
                />
              ),
          )}

          {subTab === "payBonus" && (
            <PayBonusPanel
              draft={payBonus}
              saved={saved.payBonus}
              settings={settings}
              readOnly={readOnly}
              saving={saving === "payBonus"}
              busy={saving !== null}
              onSave={savePayBonus}
            />
          )}
        </>
      )}
    </div>
  );
}
