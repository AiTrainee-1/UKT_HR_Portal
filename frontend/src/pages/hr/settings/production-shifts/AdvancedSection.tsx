import { SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Field } from "../kit/Field";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { parseNumber } from "../payroll/form";
import { roundShifts } from "./examples";
import { FULL_DAY, MIN_CREDIT, QUARTER, ROUNDING_MODES } from "./form";
import type { SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

const shifts = (n: number) => `${n.toFixed(2)} shift${n === 1 ? "" : "s"}`;

/**
 * Advanced: the three numbers most factories never change (the night session length moved to Night and early morning). Each has its own explanation and a small example worked out
 * from the box.
 */
export function AdvancedSection({ draft, patch, readOnly, validation }: SectionProps) {
  const minCredit = parseNumber(draft.minCredit, MIN_CREDIT).value;
  const fullDay = parseNumber(draft.fullDayValue, FULL_DAY).value;
  const roundingExamples = [2.72, 1.12].map((raw) => ({
    raw,
    rounded: roundShifts(raw, QUARTER, draft.roundingMode),
  }));
  const SHORT_DAY = 0.1;

  return (
    <SettingsSection
      id="production-shifts-advanced"
      icon={SlidersHorizontal}
      title={PRODUCTION_SHIFT_SECTIONS.advanced}
      purpose="Three numbers that most factories never change. They are safe as they are: change one only when HR has a reason."
      testId="production-shifts-advanced"
    >
      <SettingBlock
        {...block("min-credit")}
        labelFor="production-min-credit"
        defaultText="0 (no minimum)"
        affects={[
          {
            where: "Production Attendance",
            what: "a day with at least one complete in and out pair earns at least this many shifts",
            to: "/hr/attendance/production",
          },
        ]}
        preview={
          minCredit !== null && (
            <PreviewCard
              title="Worked example"
              scenario="A worker comes in and goes out after a very short stay."
              testId="min-credit-example"
            >
              <PreviewLine
                label={`The ladder gives ${shifts(SHORT_DAY)}`}
                result={`The day earns ${shifts(Math.max(roundShifts(SHORT_DAY, QUARTER, draft.roundingMode), minCredit))}`}
                tone={minCredit > SHORT_DAY ? "info" : "neutral"}
              />
            </PreviewCard>
          )
        }
      >
        <Field label="Minimum shifts" htmlFor="production-min-credit" unit="shifts" error={validation.minCredit}>
          <Input
            id="production-min-credit"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft.minCredit}
            disabled={readOnly}
            aria-invalid={validation.minCredit ? true : undefined}
            onChange={(e) => patch({ minCredit: e.target.value })}
            className={cn("w-28 tabular-nums", validation.minCredit && "border-red-400")}
          />
        </Field>
      </SettingBlock>

      <SettingBlock
        {...block("rounding")}
        defaultText="quarters (0.25), to the nearest quarter"
        affects={[
          {
            where: "Production Attendance and Production Payroll",
            what: "the saved shifts of a day are rounded this way, so pay is shifts times the salary per shift on the rounded figure",
            to: "/hr/production-payroll",
          },
        ]}
        preview={
          <PreviewCard
            title="Worked example"
            scenario="Two days worked out exactly, then rounded."
            testId="rounding-example"
          >
            {roundingExamples.map((x) => (
              <PreviewLine
                key={x.raw}
                label={`Worked out to ${x.raw.toFixed(2)}`}
                result={`Saved as ${shifts(x.rounded)}`}
                tone={x.rounded === x.raw ? "neutral" : "info"}
              />
            ))}
          </PreviewCard>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Step">
            {/* fixed (owner 2026-11-18): production shifts are counted in quarters only */}
            <p
              className="flex min-h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700"
              data-testid="production-rounding-step"
            >
              0.25 (quarters)
            </p>
          </Field>
          <Field label="How" htmlFor="production-rounding-mode">
            <select
              id="production-rounding-mode"
              className="h-9 w-full rounded-md border bg-white px-2 text-sm disabled:opacity-50"
              value={draft.roundingMode}
              disabled={readOnly}
              onChange={(e) => patch({ roundingMode: e.target.value as "nearest" | "down" })}
            >
              {ROUNDING_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </SettingBlock>

      <SettingBlock
        {...block("full-day-value")}
        labelFor="production-full-day"
        defaultText="1 shift"
        affects={[
          {
            where: "Production Attendance",
            what: "a day below this is shown as Half shift, a day at or above it as Present",
            to: "/hr/attendance/production",
          },
        ]}
        preview={
          fullDay !== null && (
            <PreviewCard
              title="Worked example"
              scenario="Two days that earn different shifts."
              testId="full-day-example"
            >
              {[0.75, 1.5].map((value) => (
                <PreviewLine
                  key={value}
                  label={`A day that earns ${shifts(value)}`}
                  result={value < fullDay ? "Half shift" : "Present"}
                  tone={value < fullDay ? "warn" : "good"}
                />
              ))}
            </PreviewCard>
          )
        }
      >
        <Field label="Full-day value" htmlFor="production-full-day" unit="shifts" error={validation.fullDay}>
          <Input
            id="production-full-day"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft.fullDayValue}
            disabled={readOnly}
            aria-invalid={validation.fullDay ? true : undefined}
            onChange={(e) => patch({ fullDayValue: e.target.value })}
            className={cn("w-28 tabular-nums", validation.fullDay && "border-red-400")}
          />
        </Field>
      </SettingBlock>
    </SettingsSection>
  );
}
