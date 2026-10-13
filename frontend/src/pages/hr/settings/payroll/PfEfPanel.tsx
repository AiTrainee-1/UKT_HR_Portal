import { useState } from "react";
import { Layers, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { CYCLE_INFO, type PayCycle } from "../production-payroll/cycles";
import type { Draft } from "./form";
import { bandIssues, formatPaise, productionPay, type ProductionPay } from "./preview";
import { bandErrors, hasErrors, type BandRow, type Change, type PfEfForm } from "./sections";
import { ProductionPfOrder } from "./ProductionPfOrder";
import { ConfirmChanges, InfoBox, StickySave } from "./ui";

const block = (id: string) => ({ id, ...payrollText(id) });

const EMPTY_BAND: BandRow = { label: "", minSalary: "0", maxSalary: "0", pfRate: "0", efRate: "0" };

/** One worked example per pay cycle, at different pay levels so the bands can give different answers. */
const CYCLE_EXAMPLES: { cycle: PayCycle; shifts: number }[] = [
  { cycle: "weekly", shifts: 6 },
  { cycle: "biweekly", shifts: 16 },
  { cycle: "monthly", shifts: 41 },
];

const COLUMNS: { key: Exclude<keyof BandRow, "label">; label: string; prefix?: string; unit?: string }[] = [
  { key: "minSalary", label: "Min estimated monthly pay", prefix: "₹" },
  { key: "maxSalary", label: "Max (0 = no limit)", prefix: "₹" },
  { key: "pfRate", label: "PF", unit: "%" },
  { key: "efRate", label: "EF (ESI)", unit: "%" },
];

/** Settings -> Payroll -> "Production PF/EF": salary bands that decide production PF and EF (ESI) by earnings. */
export function PfEfPanel({
  draft,
  saved,
  flat,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<PfEfForm>;
  saved: PfEfForm;
  /** The flat production rates and their switch, as on the Payroll Rules sub-tab. */
  flat: { on: boolean; pfRate: number; esiRate: number; esiCeiling: number };
  readOnly: boolean;
  saving: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const rows = form.prodPfEfRules;
  const errors = bandErrors(rows, saved.prodPfEfRules);
  const invalid = hasErrors(errors);
  const issues = bandIssues(rows);
  const [confirming, setConfirming] = useState(false);

  const setCell = (index: number, key: keyof BandRow, value: string) =>
    set(
      "prodPfEfRules",
      rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)),
    );

  const example = (shifts: number, cycle: PayCycle): ProductionPay =>
    productionPay({
      shifts,
      monthlyFactor: CYCLE_INFO[cycle].monthlyFactor,
      ratePerShift: 600,
      flatOn: flat.on,
      pfRate: flat.pfRate,
      esiRate: flat.esiRate,
      esiCeiling: flat.esiCeiling,
      bandsOn: true,
      bands: rows,
    });
  const outcome = (p: ProductionPay) =>
    p.source === "band"
      ? `${p.band?.label || `band ${p.band?.position}`}: PF ${formatPaise(p.pf)} + EF ${formatPaise(p.esi)}`
      : p.source === "flat"
        ? `no band - flat rates: PF ${formatPaise(p.pf)} + ESI ${formatPaise(p.esi)}`
        : "no band and flat rates off - no PF or ESI";

  const changes: Change[] = [];
  if (draft.changed.includes("prodPfEfEnabled")) {
    changes.push({
      label: "Use salary bands",
      from: saved.prodPfEfEnabled ? "On" : "Off",
      to: form.prodPfEfEnabled ? "On" : "Off",
    });
  }
  if (draft.changed.includes("prodPfEfRules")) {
    const count = (n: number) => `${n} band${n === 1 ? "" : "s"}`;
    changes.push({
      label: "Salary bands",
      from: count(saved.prodPfEfRules.length),
      to: `${count(rows.length)}, edited`,
    });
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Layers}
        title={PAYROLL_SECTIONS.bands}
        purpose="A second way to deduct production PF and ESI: by bands of estimated monthly pay (the period pay x 4 on the Weekly cycle, x 2 on BiWeekly, x 1 on Monthly). Used instead of the flat rates for any worker whose estimate falls in a band."
        usedBy={[{ label: "Production Payroll", to: "/hr/production-payroll" }]}
      >
        <InfoBox className="my-2">
          <p className="font-semibold">How each production payslip's PF and ESI is decided</p>
          <ProductionPfOrder
            bandsOn={form.prodPfEfEnabled}
            bandCount={rows.length}
            flatOn={flat.on}
            pfRate={flat.pfRate}
            esiRate={flat.esiRate}
          />
        </InfoBox>

        <SettingBlock
          {...block("pf-ef-switch")}
          labelFor="pf-ef-enabled"
          defaultText="Off"
          affects={[
            {
              where: "Production Payroll",
              what: "the first band (in list order) that the estimated monthly pay falls in decides PF and EF; the payslip breakdown names the band.",
              to: "/hr/production-payroll",
            },
            {
              where: "Flat rates (Payroll Rules)",
              what: "ignored for a worker whose band matched, even with their switch off. With no band matching, the flat rates apply only if their switch is on.",
              to: "/hr/settings?tab=payroll#prod-pf-esi-switch",
            },
          ]}
          note="When bands are on but none matches a worker and the flat-rate switch is off, that worker gets no PF or ESI at all."
          preview={
            <PreviewCard scenario="The bands below, ₹600 a shift.">
              {CYCLE_EXAMPLES.map(({ cycle, shifts }) => {
                const p = example(shifts, cycle);
                return (
                  <PreviewLine
                    key={cycle}
                    label={`${CYCLE_INFO[cycle].label}: ${shifts} shifts = ${formatPaise(p.gross)} (estimate ${formatPaise(p.monthlyEstimate)})`}
                    result={outcome(p)}
                  />
                );
              })}
              {!form.prodPfEfEnabled && (
                <PreviewLine tone="warn" label="The switch is off" result="these bands are not used" />
              )}
            </PreviewCard>
          }
        >
          <ToggleField
            id="pf-ef-enabled"
            checked={form.prodPfEfEnabled}
            onChange={(v) => set("prodPfEfEnabled", v)}
            onLabel="On - salary bands decide production PF and EF"
            offLabel="Off - salary bands are not used"
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("pf-ef-rules")}
          affects={[
            {
              where: "Production Payroll",
              what: "PF = period pay x the band's PF %, EF (ESI) = period pay x the band's EF %, with no ESI ceiling test; the payslip shows the band's name.",
              to: "/hr/production-payroll",
            },
          ]}
          note="Payroll does not check bands for overlaps or gaps: the example under the bands lists them."
          preview={
            <PreviewCard title="Check" scenario="Where the bands leave an estimate to chance.">
              {issues.length === 0 ? (
                <PreviewLine
                  tone={rows.length ? "good" : "neutral"}
                  label={rows.length ? "Every estimate matches exactly one band" : "No bands yet"}
                  result={rows.length ? "no gaps or overlaps" : "nothing is used"}
                />
              ) : (
                issues.map((issue) => (
                  <PreviewLine
                    key={issue.text}
                    tone={issue.kind === "overlap" ? "info" : "warn"}
                    label={issue.text}
                    result={issue.kind === "overlap" ? "overlap" : issue.kind === "gap" ? "gap" : "check"}
                  />
                ))
              )}
            </PreviewCard>
          }
        >
          <div className="space-y-2" data-testid="pf-ef-bands">
            {rows.length === 0 && (
              <p className="rounded-xl border border-dashed border-slate-200 p-3 text-center text-xs text-gray-500">
                No bands yet. With the switch on and no bands, the flat rates decide.
              </p>
            )}
            {rows.map((row, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/50 p-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-2 text-[11px] font-black text-gray-400">{i + 1}</span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <Input
                      aria-label={`Band ${i + 1} name`}
                      placeholder="Name, for example Up to 20,000"
                      value={row.label}
                      maxLength={80}
                      disabled={readOnly}
                      onChange={(e) => setCell(i, "label", e.target.value)}
                      className={cn("h-8 text-xs", errors[i]?.label && "border-red-400")}
                    />
                    {errors[i]?.label && <p className="text-[11px] font-medium text-red-600">{errors[i]?.label}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        "prodPfEfRules",
                        rows.filter((_, j) => j !== i),
                      )
                    }
                    disabled={readOnly}
                    aria-label={`Remove band ${i + 1}`}
                    title={`Remove band ${i + 1}`}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 pl-5 sm:grid-cols-4">
                  {COLUMNS.map((c) => (
                    <label key={c.key} className="min-w-0 space-y-0.5">
                      <span className="block text-[10px] font-bold uppercase tracking-wide text-gray-400">
                        {c.label}
                      </span>
                      <span className="flex items-center gap-1">
                        {c.prefix && <span className="text-xs text-gray-500">{c.prefix}</span>}
                        <Input
                          inputMode="decimal"
                          value={row[c.key]}
                          disabled={readOnly}
                          aria-invalid={errors[i]?.[c.key] ? true : undefined}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          className={cn("h-8 text-xs tabular-nums", errors[i]?.[c.key] && "border-red-400")}
                        />
                        {c.unit && <span className="text-xs text-gray-500">{c.unit}</span>}
                      </span>
                      {errors[i]?.[c.key] && (
                        <span className="block text-[11px] font-medium text-red-600">{errors[i]?.[c.key]}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly}
              onClick={() => set("prodPfEfRules", [...rows, EMPTY_BAND])}
            >
              + Add Rule
            </Button>
          </div>
        </SettingBlock>
      </SettingsSection>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => setConfirming(true)}
        onDiscard={draft.discard}
        saveLabel="Save PF/EF Rules"
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />

      <ConfirmChanges
        open={confirming}
        onOpenChange={setConfirming}
        title="Save the production PF / EF bands?"
        changes={changes}
        confirmLabel="Save changes"
        onConfirm={() => void onSave()}
      >
        <p>
          Production payslips generated from now on use them. Payslips already generated keep their PF and ESI until
          their period is generated again.
        </p>
        {issues.length > 0 && (
          <p className="text-amber-700">
            The check under the bands lists {issues.length} gap{issues.length === 1 ? "" : "s"} or overlap
            {issues.length === 1 ? "" : "s"} to look at first.
          </p>
        )}
      </ConfirmChanges>
    </div>
  );
}
