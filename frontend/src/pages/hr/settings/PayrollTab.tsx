import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Gift, IndianRupee } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  getPayrollSettingsQueryKey,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { PAYROLL_SUB_TAB_OF, type PayrollSubTab } from "./PayrollTab.meta";
import { addressSetting, saveErrorText, useDraft, useSubTabFromAddress } from "./payroll/form";
import { bonusPayload, ratesPayload, savedPayroll } from "./payroll/sections";
import { RatesPanel } from "./payroll/RatesPanel";
import { BonusPanel } from "./payroll/BonusPanel";
import { OtPanel } from "./payroll/OtPanel";
import { BranchNotice } from "./payroll/ui";

const SUB_TABS: { value: PayrollSubTab; label: string; icon: ReactNode }[] = [
  { value: "rates", label: "Payroll Rules", icon: <IndianRupee size={13} /> },
  { value: "bonus", label: "Bonus", icon: <Gift size={13} /> },
  { value: "otCompensation", label: "OT / Compensation", icon: <Clock size={13} /> },
];

type Saving = "rates" | "bonus";

/**
 * Settings -> Staff Payroll (tab id "payroll", kept: it is a permission key and the `?tab=` address). Three sub-tabs:
 * Payroll Rules (the pay day and the financial year start month, both company-wide) and Bonus (staff), each a group with
 * its own Save button that sends only that group's keys, so saving one never saves or resets another group's unsaved
 * edits, and OT & Compensation, which holds only the master switch of those features and saves itself (their rules are on
 * the Compensation tab). PF and ESI are not here: they have their own tab (PF & ESI). Production has its own tab,
 * Production Payroll (its pay periods, the suggested rate and its bonus).
 */
export default function PayrollTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdatePayrollSettings();
  const { data: settings, isLoading, isError, refetch } = usePayrollSettings();

  const saved = useMemo(() => savedPayroll(settings), [settings]);
  const rates = useDraft(saved.rates);
  const bonus = useDraft(saved.bonus);

  const [subTab, setSubTab] = useState<PayrollSubTab>(() => PAYROLL_SUB_TAB_OF[addressSetting()] ?? "rates");
  useSubTabFromAddress(PAYROLL_SUB_TAB_OF, setSubTab);

  const [saving, setSaving] = useState<Saving | null>(null);
  const [featuresPending, setFeaturesPending] = useState<boolean | null>(null);
  const featuresOn = featuresPending ?? settings?.compensationFeatureEnabled ?? true;
  const branchLogin = settings?.companyWideRulesEditable === false;

  const keepSaved = (next: PayrollSettingsItem) => queryClient.setQueryData(getPayrollSettingsQueryKey(), next);

  const runSave = async (
    group: Saving,
    payload: Partial<PayrollSettingsItem>,
    done: () => void,
    ok: { title: string; description: string },
    failTitle: string,
  ) => {
    setSaving(group);
    try {
      keepSaved(await update.mutateAsync(payload));
      done();
      toast(ok);
    } catch (err) {
      toast({ title: failTitle, description: saveErrorText(err), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const applyFeatures = async (enabled: boolean) => {
    setFeaturesPending(enabled);
    try {
      keepSaved(await update.mutateAsync({ compensationFeatureEnabled: enabled }));
      toast({
        title: enabled ? "OT & Compensation features ON" : "OT & Compensation features OFF",
        description: enabled
          ? "The Compensation features that are switched on in Settings, Compensation act again, and OT pay on payslips generated from now on is added again."
          : "OT detection, the next-day allowance, announced late-in / early-out days, birthday leave, Compensation Days and OT pay on payslips generated from now on are switched off. The Compensation page stays available and existing records are kept.",
      });
    } catch (err) {
      toast({ title: "Failed to update setting", description: saveErrorText(err), variant: "destructive" });
    } finally {
      setFeaturesPending(null);
    }
  };

  const branchOnly = branchLogin ? " They apply to your branch's employees only." : "";
  const dirtyOf: Partial<Record<PayrollSubTab, boolean>> = {
    rates: rates.dirty,
    bonus: bonus.dirty,
  };
  const unsavedElsewhere = SUB_TABS.filter((t) => t.value !== subTab && dirtyOf[t.value]).map((t) => t.label);

  return (
    <div className="space-y-4">
      {branchLogin && (
        <BranchNotice>
          You are signed in to a branch. What you save on this tab is kept apart from the company values and applies to
          your branch's employees only (payroll and bonus). OT detection, the Compensation page, the MD portal and
          Report Center always use the company values.
        </BranchNotice>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          items={SUB_TABS}
          value={subTab}
          onChange={(v) => setSubTab(v as PayrollSubTab)}
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
        <div className="space-y-3" data-testid="payroll-settings-loading">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : isError || !settings ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800">
          Could not load the payroll settings.
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {subTab === "rates" && (
            <RatesPanel
              draft={rates}
              saved={saved.rates}
              settings={settings}
              readOnly={readOnly}
              saving={saving === "rates"}
              busy={saving !== null}
              onSave={() =>
                runSave(
                  "rates",
                  ratesPayload(rates.form),
                  rates.discard,
                  {
                    title: "Payroll settings saved",
                    description: `Payroll generated from now on uses them; payslips already generated keep their amounts until they are generated again.${branchOnly}`,
                  },
                  "Failed to save payroll settings",
                )
              }
            />
          )}
          {subTab === "bonus" && (
            <BonusPanel
              draft={bonus}
              saved={saved.bonus}
              fyStartMonth={settings.bonusFyStartMonth ?? 4}
              readOnly={readOnly}
              saving={saving === "bonus"}
              busy={saving !== null}
              onSave={() =>
                runSave(
                  "bonus",
                  bonusPayload(bonus.form),
                  bonus.discard,
                  {
                    title: "Staff bonus settings saved",
                    description: `The Bonus page's figures use them at once; a bonus register already generated changes only when Generate is run again.${branchOnly}`,
                  },
                  "Failed to save bonus settings",
                )
              }
            />
          )}
          {subTab === "otCompensation" && (
            <OtPanel
              featuresOn={featuresOn}
              onFeatures={(enabled) => void applyFeatures(enabled)}
              branchLogin={branchLogin}
              readOnly={readOnly || featuresPending !== null}
            />
          )}
        </>
      )}
    </div>
  );
}
