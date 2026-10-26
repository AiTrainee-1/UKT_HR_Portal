import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_ARRIVAL } from "@/lib/arrival-rules";
import {
  getPayrollSettingsQueryKey,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type PayCycle,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { ConfirmSave } from "./attendance/ConfirmSave";
import { SaveFooter } from "./attendance/SaveFooter";
import { TabContents } from "./attendance/TabContents";
import { useDraft } from "./attendance/useDraft";
import { CLASS_VIEWS, ClassPills, UnsavedChip, useAddressView } from "./kit/view";
import { LATE_CYCLE_OF, LATE_VIEW_OF } from "./LateDetectionTab.meta";
import {
  capChanges,
  capDraftFrom,
  capDraftProblem,
  capPayload,
  lateChanges,
  lateDraftFrom,
  latePayload,
  lateProblem,
  pricingChanges,
  pricingDraftFrom,
  pricingDraftProblem,
  pricingPayload,
  sameCap,
  sameLate,
  samePricing,
  slabsOf,
} from "./late_detection/form";
import { PermissionSection } from "./late_detection/PermissionSection";
import { PolicySection } from "./late_detection/PolicySection";
import { PoolIntro } from "./late_detection/PoolIntro";
import { PricingSection } from "./late_detection/PricingSection";
import { ProductionPage } from "./late_detection/ProductionPage";
import {
  changedCycles,
  cycleLateRules,
  firstLateProblem,
  productionLateChanges,
  productionLatePayload,
  sameProductionLate,
  savedProductionLate,
  sharedLatePayload,
  type ProductionLatePayload,
} from "./late_detection/production";
import { addressSetting, saveErrorText, useSubTabFromAddress } from "./payroll/form";
import { CYCLE_INFO } from "./production-payroll/cycles";

const STAFF_CONTENTS = [
  { id: "late-pool-intro", label: "How the pool works" },
  { id: "late-policy-section", label: "Free allowance and slabs" },
  { id: "permission-policy-section", label: "Permission cap" },
  { id: "permission-pricing-section", label: "Permission pricing" },
];

const PRODUCTION_CONTENTS = [
  { id: "production-late-section", label: "Switch and what counts as late" },
  { id: "production-late-cycle-pills", label: "Free late days and slabs by cycle" },
];

type Saving = "late" | "cap" | "pricing" | "production";

const failure = (err: unknown): string | undefined =>
  saveErrorText(err) ?? (err instanceof Error ? err.message : undefined);

/**
 * Settings -> Late Detection, a Staff page and a Production page behind a pill switch.
 *
 * Staff: what the month's Late / Early Out / extra-permission marks cost, how many approved permissions a month protect a
 * day, and, behind a switch, whether the extra permissions are priced on their own. Three independent forms, each with its
 * own Save (and a confirm first: all of them change pay for everyone).
 *
 * Production: the switch, what counts as late and each pay cycle's free late days and slabs. One form, one Save that sends
 * only what changed (the pay period rules of the same cycles are saved from Production Payroll; the server merges
 * `prodCycles` key by key, so neither save overwrites the other).
 *
 * Every form's draft lives here, so switching pills never loses what was typed.
 */
export default function LateDetectionTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = usePayrollSettings();
  const update = useUpdatePayrollSettings();

  const [view, chooseView] = useAddressView(CLASS_VIEWS, "staff", LATE_VIEW_OF);
  const [cycle, setCycle] = useState<PayCycle>(() => LATE_CYCLE_OF[addressSetting()] ?? "weekly");
  const openCycle = useCallback((next: PayCycle) => setCycle(next), []);
  useSubTabFromAddress(LATE_CYCLE_OF, openCycle, { focus: false });

  const savedLate = useMemo(() => (data ? lateDraftFrom(data) : null), [data]);
  const savedCap = useMemo(() => (data ? capDraftFrom(data) : null), [data]);
  const savedPricing = useMemo(() => (data ? pricingDraftFrom(data) : null), [data]);
  const savedProduction = useMemo(() => (data ? savedProductionLate(data) : null), [data]);
  const late = useDraft(savedLate, sameLate);
  const capForm = useDraft(savedCap, sameCap);
  const pricingForm = useDraft(savedPricing, samePricing);
  const production = useDraft(savedProduction, sameProductionLate);
  const loaded = !!data && !!late.draft && !!capForm.draft && !!pricingForm.draft && !!production.draft;
  const lateDraft = late.draft ?? lateDraftFrom({});
  const capDraft = capForm.draft ?? capDraftFrom({});
  const pricingDraft = pricingForm.draft ?? pricingDraftFrom({});
  const productionDraft = production.draft ?? savedProductionLate(undefined);

  // A branch-assigned login sees the company-wide cap and permission pricing but the server refuses (403) a save that carries
  // them; an older backend that does not report them cannot have them changed here. The allowance and slabs are not
  // company-wide.
  const companyWideEditable = data?.companyWideRulesEditable !== false;
  const capReported = data?.permissionMonthlyCap != null;
  const pricingReported = data?.permissionPricingEnabled != null;
  const morningOn = data?.morningLateInEnabled;
  const eveningOn = data?.eveningEarlyOutEnabled;
  const savedArrival = {
    lateWindowMinutes: data?.arrivalLateWindowMinutes ?? DEFAULT_ARRIVAL.lateWindowMinutes,
    permissionWindowMinutes: data?.arrivalPermissionWindowMinutes ?? DEFAULT_ARRIVAL.permissionWindowMinutes,
    extraMinutes: data?.arrivalExtraMinutes ?? DEFAULT_ARRIVAL.extraMinutes,
    quarterDeduction: data?.arrivalQuarterDeduction ?? DEFAULT_ARRIVAL.quarterDeduction,
  };

  const lateError = lateProblem(lateDraft);
  const capError = companyWideEditable && capReported ? capDraftProblem(capDraft) : null;
  const capShown = capError ? (data?.permissionMonthlyCap ?? 3) : Number(capDraft.cap);
  const pricingError = companyWideEditable && pricingReported ? pricingDraftProblem(pricingDraft) : null;
  const productionError =
    savedProduction && production.draft
      ? firstLateProblem(production.draft, savedProduction, (c) => CYCLE_INFO[c].label)
      : null;

  const [confirming, setConfirming] = useState<Saving | null>(null);
  const [saving, setSaving] = useState<Saving | null>(null);

  const saveLate = async () => {
    setConfirming(null);
    if (!late.draft || lateError) return;
    setSaving("late");
    try {
      await update.mutateAsync(latePayload(late.draft) as never);
      toast({
        title: "Late Detection policy saved",
        description: companyWideEditable
          ? "Payroll generated from now on uses it. Payslips already generated keep their amounts until that month's payroll is generated again; the Report Log and the employee apps already show the new deduction."
          : "Saved for your branch only: payroll keeps using the company-wide values.",
      });
    } catch (err) {
      toast({
        title: "Failed to save Late Detection policy",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  };

  const saveCap = async () => {
    setConfirming(null);
    if (!capForm.draft || capError || !companyWideEditable || !capReported) return;
    setSaving("cap");
    try {
      await update.mutateAsync(capPayload(capForm.draft) as never);
      toast({
        title: "Permission policy saved",
        description:
          "Days are re-judged with the new cap the next time they are opened, past months included. Payslips already generated keep their amounts until that month's payroll is generated again.",
      });
    } catch (err) {
      toast({
        title: "Failed to save Permission policy",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  };

  const savePricing = async () => {
    setConfirming(null);
    if (!pricingForm.draft || pricingError || !companyWideEditable || !pricingReported) return;
    setSaving("pricing");
    try {
      await update.mutateAsync(pricingPayload(pricingForm.draft) as never);
      toast({
        title: "Permission pricing saved",
        description:
          "Payroll generated from now on prices the permissions beyond the cap this way. Payslips already generated keep their amounts until that month's payroll is generated again; the Report Log and the employee apps already show the new deduction.",
      });
    } catch (err) {
      toast({ title: "Failed to save Permission pricing", description: failure(err), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const keepSaved = (fresh: PayrollSettingsItem) => queryClient.setQueryData(getPayrollSettingsQueryKey(), fresh);

  const saveProduction = async () => {
    setConfirming(null);
    if (!production.draft || !savedProduction || productionError) return;
    setSaving("production");
    try {
      // The hook types prodCycles as the server answers it (every cycle, every key); a save sends the patch shape.
      const fresh = await update.mutateAsync(
        productionLatePayload(production.draft, savedProduction) as Partial<PayrollSettingsItem>,
      );
      keepSaved(fresh);
      // everything on the page was just saved: show it as the server now has it (numbers written the way it writes them)
      production.setDraft(savedProductionLate(fresh));
      toast({
        title: "Production Late Detection saved",
        description:
          "Applies the next time a production period is generated; payslips already generated keep their late deduction until their period is generated again.",
      });
    } catch (err) {
      toast({ title: "Failed to save Production Late Detection", description: failure(err), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  /** Hands the cycle's late rules back to the shared ones; the form then shows those (unsaved late edits are dropped). */
  const useSharedRules = async (target: PayCycle) => {
    const label = CYCLE_INFO[target].label;
    setSaving("production");
    try {
      const payload: ProductionLatePayload = sharedLatePayload(target);
      const fresh = await update.mutateAsync(payload as Partial<PayrollSettingsItem>);
      keepSaved(fresh);
      const now = savedProductionLate(fresh).cycles[target];
      production.setDraft((d) => (d ? { ...d, cycles: { ...d.cycles, [target]: now } } : d));
      toast({
        title: `${label} uses the shared late rules again`,
        description: `${label} payslips generated from now on follow the shared production allowance and slabs.`,
      });
    } catch (err) {
      toast({ title: `Failed to change the ${label} late rules`, description: failure(err), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const hint = (problem: string | null) =>
    readOnly
      ? "View only: you can try values to see the examples, but they cannot be saved."
      : !loaded
        ? "Loading the saved settings…"
        : problem
          ? `Fix this first: ${problem}`
          : undefined;

  const staffDirty = late.dirty || capForm.dirty || pricingForm.dirty;
  // the cycles whose late values were edited and that still follow the shared production values: saving gives them their own
  const productionShared =
    data && production.draft && savedProduction
      ? changedCycles(production.draft, savedProduction)
          .filter((c) => !cycleLateRules(data, c).own)
          .map((c) => CYCLE_INFO[c].label)
      : [];

  return (
    <div className="space-y-4" data-testid="late-detection-tab">
      <ClassPills value={view} onChange={chooseView}>
        {view === "staff" && production.dirty && <UnsavedChip>Not saved yet: Production</UnsavedChip>}
        {view === "production" && staffDirty && <UnsavedChip>Not saved yet: Staff</UnsavedChip>}
      </ClassPills>

      {view === "staff" ? (
        <div className="space-y-4" data-testid="late-page-staff">
          <TabContents items={STAFF_CONTENTS} />
          <PoolIntro morningOn={morningOn} eveningOn={eveningOn} pricingOn={pricingDraft.enabled} />

          <div className="space-y-4">
            <PolicySection
              draft={lateDraft}
              update={late.update}
              loaded={loaded}
              branchLogin={!companyWideEditable}
              morningOn={morningOn}
              eveningOn={eveningOn}
              cap={capShown}
              permissionsPriced={pricingDraft.enabled}
            />
            <SaveFooter
              dirty={late.dirty}
              saving={saving === "late"}
              onSave={() => setConfirming("late")}
              onDiscard={late.discard}
              saveLabel="Save Late Detection Policy"
              disabled={readOnly || !loaded || !late.dirty || !!lateError}
              hint={hint(lateError)}
            />
          </div>

          <div className="space-y-4">
            <PermissionSection
              draft={capDraft}
              update={capForm.update}
              loaded={loaded}
              companyWideEditable={companyWideEditable}
              capReported={capReported}
              arrival={savedArrival}
              secondHalfStart={data?.halfDaySecondHalfStartTime ?? null}
              morningOn={morningOn}
              permissionsPriced={pricingDraft.enabled}
            />
            <SaveFooter
              dirty={capForm.dirty}
              saving={saving === "cap"}
              onSave={() => setConfirming("cap")}
              onDiscard={capForm.discard}
              saveLabel="Save Permission Policy"
              disabled={readOnly || !loaded || !capForm.dirty || !!capError || !companyWideEditable || !capReported}
              hint={
                !readOnly && loaded && !companyWideEditable
                  ? "The monthly cap is a company-wide rule: only an administrator can change it."
                  : hint(capError)
              }
            />
          </div>

          <div className="space-y-4">
            <PricingSection
              draft={pricingDraft}
              update={pricingForm.update}
              loaded={loaded}
              companyWideEditable={companyWideEditable}
              reported={pricingReported}
              cap={capShown}
              lateAllowance={lateError ? (data?.lateFreeAllowance ?? 3) : Number(lateDraft.allowance)}
              lateSlabs={lateError ? (data?.lateDeductionSlabs ?? []) : slabsOf(lateDraft)}
              morningOn={morningOn}
              eveningOn={eveningOn}
            />
            <SaveFooter
              dirty={pricingForm.dirty}
              saving={saving === "pricing"}
              onSave={() => setConfirming("pricing")}
              onDiscard={pricingForm.discard}
              saveLabel="Save Permission Pricing"
              disabled={
                readOnly || !loaded || !pricingForm.dirty || !!pricingError || !companyWideEditable || !pricingReported
              }
              hint={
                !readOnly && loaded && !companyWideEditable
                  ? "Permission pricing is a company-wide rule: only an administrator can change it."
                  : hint(pricingError)
              }
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4" data-testid="late-page-production-wrap">
          <TabContents items={PRODUCTION_CONTENTS} />
          {data && production.draft && savedProduction ? (
            <ProductionPage
              form={production.draft}
              saved={savedProduction}
              update={production.update}
              settings={data}
              cycle={cycle}
              onCycle={setCycle}
              branchLogin={!companyWideEditable}
              readOnly={readOnly}
              busy={saving !== null}
              onUseShared={useSharedRules}
            />
          ) : (
            <p className="text-sm text-gray-500" data-testid="late-production-loading">
              Loading the saved settings…
            </p>
          )}
          <SaveFooter
            dirty={production.dirty}
            saving={saving === "production"}
            onSave={() => setConfirming("production")}
            onDiscard={production.discard}
            saveLabel="Save Production Late Detection"
            disabled={readOnly || !loaded || !production.dirty || !!productionError || saving !== null}
            hint={hint(productionError)}
          />
        </div>
      )}

      <ConfirmSave
        open={confirming === "late"}
        onOpenChange={(open) => setConfirming(open ? "late" : null)}
        title="Save the Late Detection policy?"
        changes={savedLate ? lateChanges(lateDraft, savedLate) : []}
        onConfirm={() => void saveLate()}
        consequences={[
          "Every payroll generated from now on deducts with these values, for every staff member.",
          "Payslips already generated keep their amounts until that month's payroll is generated again; the Report Log, the shift statistics and the employee apps show the new deduction for past months straight away.",
          ...(companyWideEditable
            ? []
            : [
                "You are signed in for a branch: this is saved for your branch only, and payroll keeps the company-wide values.",
              ]),
        ]}
      />
      <ConfirmSave
        open={confirming === "cap"}
        onOpenChange={(open) => setConfirming(open ? "cap" : null)}
        title="Save the Permission policy?"
        changes={savedCap ? capChanges(capDraft, savedCap) : []}
        onConfirm={() => void saveCap()}
        consequences={[
          "Days are re-judged with the new cap the next time they are opened, past months included: a lower cap turns earlier approvals into Excess and excused days into Late days, a higher cap does the reverse.",
          "Requests are never blocked by the cap; it only decides which approvals protect a day.",
          "Payslips already generated keep their amounts until that month's payroll is generated again.",
        ]}
      />
      <ConfirmSave
        open={confirming === "pricing"}
        onOpenChange={(open) => setConfirming(open ? "pricing" : null)}
        title="Save the permission pricing?"
        changes={savedPricing ? pricingChanges(pricingDraft, savedPricing) : []}
        testId="confirm-permission-pricing"
        onConfirm={() => void savePricing()}
        consequences={[
          pricingDraft.enabled
            ? "Every payroll generated from now on prices the permissions beyond the monthly cap on their own, for every staff member, and they no longer count as marks of the late pool: the same incident is never deducted twice."
            : "The permissions beyond the monthly cap are marks of the late pool again, priced with the free allowance and the late slabs.",
          "Payslips already generated keep their amounts until that month's payroll is generated again; the Report Log, the shift statistics and the employee apps show the new deduction for past months straight away.",
          "Production workers' permissions are never priced.",
        ]}
      />
      <ConfirmSave
        open={confirming === "production"}
        onOpenChange={(open) => setConfirming(open ? "production" : null)}
        title="Save the production late detection?"
        changes={savedProduction ? productionLateChanges(productionDraft, savedProduction) : []}
        testId="confirm-production-late"
        onConfirm={() => void saveProduction()}
        consequences={[
          "Production payslips generated from now on use it, on the cycles it changes, backfilled past periods included. Payslips already generated keep their late deduction until their period is generated again.",
          ...(productionShared.length > 0
            ? [
                `${productionShared.join(", ")} ${productionShared.length === 1 ? "stops" : "stop"} following the shared production values and ${productionShared.length === 1 ? "keeps" : "keep"} these as ${productionShared.length === 1 ? "its" : "their"} own; the other cycles are not affected.`,
              ]
            : []),
          "The pay period rules of the cycles (week start, first period start) are not changed by this save.",
          ...(companyWideEditable
            ? []
            : ["You are signed in for a branch: this applies to your branch's employees only."]),
        ]}
      />
    </div>
  );
}
