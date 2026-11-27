import { useState, type ReactNode } from "react";
import { Banknote, Landmark, ListChecks, RotateCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useUpdateSettlementSettings,
  type SettlementSettings,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { ordinal, salaryAdvanceRuleLines, termLoanRuleLines } from "../../settlement/rules";
import { errorText } from "../identity/errors";
import { metaOf } from "../identity/meta";
import { SaveFooter } from "../identity/SaveFooter";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { SETTLEMENT_SETTINGS } from "../SettlementTab.meta";
import {
  SA_FIELD,
  TL_FIELD,
  fieldOfServer,
  hasProblems,
  saChanges,
  saFormOf,
  saProblems,
  saRulesOf,
  tlChanges,
  tlFormOf,
  tlProblems,
  tlRulesOf,
  type Limits,
  type SaForm,
  type SaKey,
  type TlForm,
  type TlKey,
} from "./rules-form";

const meta = (id: string) => metaOf(SETTLEMENT_SETTINGS, id);

/** One whole-number rule: its label, the box, what it is counted in, its range and the problem under it. */
function NumberRule({
  id,
  label,
  value,
  onChange,
  unit,
  range,
  problem,
  disabled,
  prefix,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (next: string) => void;
  unit?: string;
  range?: { min: number; max: number };
  problem?: string;
  disabled: boolean;
  prefix?: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-[13px] font-medium text-slate-700">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {prefix && <span className="text-[13px] text-slate-500">{prefix}</span>}
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          step={1}
          min={range?.min}
          max={range?.max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-9 w-28"
          aria-invalid={!!problem}
          aria-describedby={problem ? `${id}-problem` : `${id}-range`}
          data-testid={id}
        />
        {unit && <span className="text-[13px] text-slate-600">{unit}</span>}
      </div>
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="text-xs font-medium text-red-600" data-testid={`${id}-problem`}>
          {problem}
        </p>
      ) : (
        range && (
          <p id={`${id}-range`} className="text-[11px] text-slate-400">
            {range.min} to {range.max}
          </p>
        )
      )}
    </div>
  );
}

/** One on/off rule. */
function ToggleRule({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
  problem,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  problem?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        data-testid={id}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13px] font-medium text-slate-700">
          {label}
        </label>
        <p id={`${id}-help`} className="text-[12px] text-slate-500">
          {help}
        </p>
        {problem && (
          <p role="alert" className="text-xs font-medium text-red-600" data-testid={`${id}-problem`}>
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}

/** The rules as employees will read them (from what the form says now). */
function Preview({ lines, testId }: { lines: string[]; testId: string }) {
  return (
    <div className="settings-clay-inset p-3.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <ListChecks size={12} aria-hidden /> As employees will see it
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-snug text-slate-700" data-testid={testId}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

type ServerProblem<K extends string> = { key: K | null; text: string } | null;

/** The server's refusal of a block: its words and the form field it names. */
function refusalOf<K extends string>(err: unknown, map: Record<K, string>, fallback: string): ServerProblem<K> {
  const body = err instanceof ApiError ? (err.data as { field?: string } | null) : null;
  return { key: fieldOfServer(map, body?.field), text: errorText(err) ?? fallback };
}

const editHint = (canChange: boolean, readOnly: boolean) =>
  !canChange && !readOnly
    ? "Company-wide: only a login for all units with the Settings edit right can change the rules."
    : undefined;

/**
 * Settings -> Loan & Advance -> Salary Advance Rules (owner 2026-11-27): how much (a % of the salary earned from the 1st to
 * a day), when employees apply (a window of days), how many a month and whether a rejected one counts. Reset to defaults
 * fills in the server's defaults; Save sends only what changed in this block.
 */
export function SalaryAdvanceRulesForm({
  data,
  canChange,
  readOnly,
}: {
  data: SettlementSettings;
  canChange: boolean;
  readOnly: boolean;
}) {
  const { toast } = useToast();
  const update = useUpdateSettlementSettings();
  const saved = data.salaryAdvanceRules;
  const defaults = data.ruleDefaults?.salaryAdvance;
  const limits: Limits = data.ruleLimits ?? {};
  const [draft, setDraft] = useState<SaForm | null>(null);
  const [server, setServer] = useState<ServerProblem<SaKey>>(null);

  if (!saved) {
    return (
      <p className="settings-glass rounded-xl p-4 text-sm text-slate-600" data-testid="sl-sa-missing">
        This server does not send the Salary Advance rules yet.
      </p>
    );
  }
  const form = draft ?? saFormOf(saved);
  const problems = saProblems(form, limits);
  const changes = saChanges(saved, form);
  const dirty = Object.keys(changes).length > 0 || (draft !== null && hasProblems(problems));
  const set = (p: Partial<SaForm>) => {
    setDraft({ ...form, ...p });
    setServer(null);
  };
  const problem = (key: SaKey) => problems[key] ?? (server?.key === key ? server.text : undefined);
  const range = (key: SaKey) => limits[SA_FIELD[key]];
  const locked = !canChange;

  const save = async () => {
    if (!dirty || hasProblems(problems)) return;
    try {
      await update.mutateAsync({ salaryAdvanceRules: changes });
      setDraft(null);
      setServer(null);
      toast({ title: "Salary Advance rules saved", description: "New requests follow them at once." });
    } catch (err) {
      setServer(refusalOf(err, SA_FIELD, "The rules could not be saved."));
    }
  };

  return (
    <>
      <SettingsSection
        icon={Banknote}
        title="Salary Advance rules"
        purpose="How much a Salary Advance can be, when employees may apply, and how many a month. Requests already made keep the figures they were made with."
        testId="sl-sa-rules"
      >
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => defaults && set(saFormOf(defaults))}
            disabled={locked || !defaults}
            data-testid="sl-sa-reset"
          >
            <RotateCcw size={13} /> Reset to defaults
          </Button>
        </div>
        <SettingBlock
          {...meta("sl-sa-amount")}
          defaultText={
            defaults
              ? `${defaults.percent}% of the salary earned from the 1st to the ${ordinal(defaults.earnedThroughDay)}`
              : undefined
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberRule
              id="sl-sa-percent"
              label="Eligible share of the earned salary"
              value={form.percent}
              onChange={(v) => set({ percent: v })}
              unit="%"
              range={range("percent")}
              problem={problem("percent")}
              disabled={locked}
            />
            <NumberRule
              id="sl-sa-earned-through"
              label="Earned salary counted from the 1st to day"
              value={form.earnedThroughDay}
              onChange={(v) => set({ earnedThroughDay: v })}
              unit="of the month"
              range={range("earnedThroughDay")}
              problem={problem("earnedThroughDay")}
              disabled={locked}
            />
          </div>
        </SettingBlock>
        <SettingBlock {...meta("sl-sa-window")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberRule
              id="sl-sa-window-from"
              label="From day"
              value={form.windowFromDay}
              onChange={(v) => set({ windowFromDay: v })}
              unit="of the month"
              range={range("windowFromDay")}
              problem={problem("windowFromDay")}
              disabled={locked}
            />
            <NumberRule
              id="sl-sa-window-to"
              label="To day"
              value={form.windowToDay}
              onChange={(v) => set({ windowToDay: v })}
              unit="of the month"
              range={range("windowToDay")}
              problem={problem("windowToDay")}
              disabled={locked}
            />
          </div>
        </SettingBlock>
        <SettingBlock {...meta("sl-sa-count")}>
          <div className="space-y-4">
            <NumberRule
              id="sl-sa-per-month"
              label="Salary Advances a month"
              value={form.perMonth}
              onChange={(v) => set({ perMonth: v })}
              unit="per employee"
              range={range("perMonth")}
              problem={problem("perMonth")}
              disabled={locked}
            />
            <ToggleRule
              id="sl-sa-rejected"
              label="A rejected request does not count"
              help="On: an employee whose request was rejected may apply again in the same month. Off: a rejected request uses up one of the month's Salary Advances."
              checked={form.rejectedAllowsReapply}
              onChange={(v) => set({ rejectedAllowsReapply: v })}
              disabled={locked}
              problem={server?.key === "rejectedAllowsReapply" ? server.text : undefined}
            />
          </div>
        </SettingBlock>
        {server && !server.key && (
          <p className="text-xs font-medium text-red-600" role="alert" data-testid="sl-sa-error">
            {server.text}
          </p>
        )}
        <Preview lines={salaryAdvanceRuleLines(saRulesOf(form, saved))} testId="sl-sa-preview" />
      </SettingsSection>
      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(null);
          setServer(null);
        }}
        saveLabel="Save Salary Advance rules"
        disabled={locked || !dirty || hasProblems(problems)}
        hint={
          editHint(canChange, readOnly) ??
          (hasProblems(problems) ? "Fix the highlighted fields first." : dirty ? "Unsaved changes." : undefined)
        }
      />
    </>
  );
}

/**
 * Settings -> Loan & Advance -> Term Loan Rules (owner 2026-11-27; staff only): the limit as a % of the fixed monthly
 * salary (above 100 % only with its own switch), the most months and the smallest amount, how many a calendar year, the
 * service needed, waiting after a rejection and one open loan at a time.
 */
export function TermLoanRulesForm({
  data,
  canChange,
  readOnly,
}: {
  data: SettlementSettings;
  canChange: boolean;
  readOnly: boolean;
}) {
  const { toast } = useToast();
  const update = useUpdateSettlementSettings();
  const saved = data.termLoanRules;
  const defaults = data.ruleDefaults?.termLoan;
  const limits: Limits = data.ruleLimits ?? {};
  const [draft, setDraft] = useState<TlForm | null>(null);
  const [server, setServer] = useState<ServerProblem<TlKey>>(null);

  if (!saved) {
    return (
      <p className="settings-glass rounded-xl p-4 text-sm text-slate-600" data-testid="sl-tl-missing">
        This server does not send the Term Loan rules yet.
      </p>
    );
  }
  const form = draft ?? tlFormOf(saved);
  const problems = tlProblems(form, limits);
  const changes = tlChanges(saved, form);
  const dirty = Object.keys(changes).length > 0 || (draft !== null && hasProblems(problems));
  const set = (p: Partial<TlForm>) => {
    setDraft({ ...form, ...p });
    setServer(null);
  };
  const problem = (key: TlKey) => problems[key] ?? (server?.key === key ? server.text : undefined);
  const range = (key: TlKey) => limits[TL_FIELD[key]];
  const locked = !canChange;
  const above = Number(form.limitPercent) > 100;

  const save = async () => {
    if (!dirty || hasProblems(problems)) return;
    try {
      await update.mutateAsync({ termLoanRules: changes });
      setDraft(null);
      setServer(null);
      toast({ title: "Term Loan rules saved", description: "New requests follow them at once." });
    } catch (err) {
      setServer(refusalOf(err, TL_FIELD, "The rules could not be saved."));
    }
  };

  return (
    <>
      <SettingsSection
        icon={Landmark}
        title="Term Loan rules"
        purpose="How much a Term Loan can be, how it is repaid, and who may apply how often. Requests already made keep the figures they were made with."
        testId="sl-tl-rules"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            className="flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[12px] font-semibold text-sky-800"
            data-testid="sl-tl-staff-only"
          >
            <Users size={13} aria-hidden /> Term Loans are for staff employees only.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => defaults && set(tlFormOf(defaults))}
            disabled={locked || !defaults}
            data-testid="sl-tl-reset"
          >
            <RotateCcw size={13} /> Reset to defaults
          </Button>
        </div>
        <SettingBlock {...meta("sl-tl-limit")}>
          <div className="space-y-4">
            <NumberRule
              id="sl-tl-limit-percent"
              label="Most a Term Loan can be, as a share of the fixed monthly salary"
              value={form.limitPercent}
              onChange={(v) => set({ limitPercent: v })}
              unit="%"
              range={range("limitPercent")}
              problem={problem("limitPercent")}
              disabled={locked}
            />
            <ToggleRule
              id="sl-tl-above"
              label="Allow loan above monthly salary"
              help="Off: a Term Loan is at most one month's fixed salary, whatever % is set above (a % over 100 is not used). On: the % above may go over 100, for example 150% = one and a half months' salary."
              checked={form.allowAboveSalary}
              onChange={(v) => set({ allowAboveSalary: v })}
              disabled={locked}
              problem={server?.key === "allowAboveSalary" ? server.text : undefined}
            />
            {above && form.allowAboveSalary && (
              <p className="text-[12px] font-medium text-amber-700" data-testid="sl-tl-above-note">
                Loans above the monthly salary are allowed: up to {form.limitPercent}% of it.
              </p>
            )}
          </div>
        </SettingBlock>
        <SettingBlock {...meta("sl-tl-repay")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberRule
              id="sl-tl-max-months"
              label="Most repayment months"
              value={form.maxMonths}
              onChange={(v) => set({ maxMonths: v })}
              unit="monthly EMIs"
              range={range("maxMonths")}
              problem={problem("maxMonths")}
              disabled={locked}
            />
            <NumberRule
              id="sl-tl-min-amount"
              label="Smallest Term Loan"
              prefix="₹"
              value={form.minAmount}
              onChange={(v) => set({ minAmount: v })}
              range={range("minAmount")}
              problem={problem("minAmount")}
              disabled={locked}
            />
          </div>
        </SettingBlock>
        <SettingBlock {...meta("sl-tl-when")}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberRule
                id="sl-tl-per-year"
                label="Term Loans per calendar year"
                value={form.perYear}
                onChange={(v) => set({ perYear: v })}
                unit="per employee"
                range={range("perYear")}
                problem={problem("perYear")}
                disabled={locked}
              />
              <NumberRule
                id="sl-tl-service"
                label="Service needed first"
                value={form.minServiceMonths}
                onChange={(v) => set({ minServiceMonths: v })}
                unit="months"
                range={range("minServiceMonths")}
                problem={problem("minServiceMonths")}
                disabled={locked}
              />
            </div>
            <ToggleRule
              id="sl-tl-reapply"
              label="After a rejection, apply again from the next month"
              help="On: an employee whose Term Loan was rejected may apply again from the 1st of the next month. Off: they may apply again at once."
              checked={form.reapplyNextMonth}
              onChange={(v) => set({ reapplyNextMonth: v })}
              disabled={locked}
            />
            <ToggleRule
              id="sl-tl-one-open"
              label="One waiting or active Term Loan at a time"
              help="On: a new Term Loan can be asked for only once the earlier one is decided and, if approved, fully repaid."
              checked={form.oneOpenAtATime}
              onChange={(v) => set({ oneOpenAtATime: v })}
              disabled={locked}
            />
          </div>
        </SettingBlock>
        {server && !server.key && (
          <p className="text-xs font-medium text-red-600" role="alert" data-testid="sl-tl-error">
            {server.text}
          </p>
        )}
        <Preview lines={termLoanRuleLines(tlRulesOf(form, saved))} testId="sl-tl-preview" />
      </SettingsSection>
      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(null);
          setServer(null);
        }}
        saveLabel="Save Term Loan rules"
        disabled={locked || !dirty || hasProblems(problems)}
        hint={
          editHint(canChange, readOnly) ??
          (hasProblems(problems) ? "Fix the highlighted fields first." : dirty ? "Unsaved changes." : undefined)
        }
      />
    </>
  );
}
