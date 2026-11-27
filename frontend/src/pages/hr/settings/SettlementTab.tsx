import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Landmark,
  ListChecks,
  Mail,
  RefreshCw,
  Scale,
  Workflow,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useSettlementSettings,
  useUpdateSettlementSettings,
  type SettlementMethod,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import { SettingBlock, SettingsSection, type Affect } from "./kit/SettingBlock";
import { errorText } from "./identity/errors";
import { metaOf } from "./identity/meta";
import { SaveFooter } from "./identity/SaveFooter";
import { addressSetting, useSubTabFromAddress } from "./payroll/form";
import { SETTLEMENT_SETTINGS, SETTLEMENT_SUB_TAB_OF, type SettlementSubTab } from "./SettlementTab.meta";
import { SalaryAdvanceRulesForm, TermLoanRulesForm } from "./settlement/RulesForms";
import {
  EMAIL_FIELDS,
  MAX_EMAILS,
  METHOD_LABEL,
  addEmails,
  ccWithoutTo,
  changedEmails,
  emailFormOf,
  LINK_DAYS_LIMITS,
  inProgressText,
  linkDaysProblem,
  removeEmail,
  type EmailField,
  type EmailForm,
} from "./settlement/logic";
import { LOAN_ADVANCE_BASE } from "../settlement/routes";

const meta = (id: string) => metaOf(SETTLEMENT_SETTINGS, id);

const STAGES = [
  "Employee Requests Received",
  "HR Review",
  "MD Review & Approval",
  "HR Final Settlement",
  "Send to Auditor (a secure review link)",
  "Auditor Review (in the Auditor Review Portal)",
  "HR Review of Auditor Changes (only when the auditor changed something)",
  "Send Bank File to Accounts (by the auditor or HR)",
  "Settlement Workflow Completed",
];

const NORMAL_AFFECTS: Affect[] = [
  {
    where: "Loan & Advance",
    what: "HR approves or rejects each request on its own, as always",
    to: LOAN_ADVANCE_BASE,
  },
  { where: "Requests", what: "Salary Advances and Term Loans are approved or rejected there too", to: "/hr/requests" },
];

const AUTOMATION_AFFECTS: Affect[] = [
  {
    where: "Loan & Advance",
    what: "becomes the month-wise workflow with its tracker, one per type (Salary Advance, Term Loan)",
    to: LOAN_ADVANCE_BASE,
  },
  {
    where: "Requests",
    what: "a Salary Advance or Term Loan can no longer be approved or rejected there",
    to: "/hr/requests",
  },
  { where: "MD portal", what: "the MD approves, reduces or rejects each forwarded request" },
  { where: "Auto-Reject Requests", what: "never rejects a Salary Advance or Term Loan while it is on" },
];

const FIELD_TEXT: Record<EmailField, { label: string; hint: string }> = {
  auditorEmails: { label: "To", hint: "The finalized report (PDF and Excel) is e-mailed to these addresses." },
  auditorCc: { label: "CC", hint: "A copy goes to these addresses (optional)." },
  accountsEmails: { label: "To", hint: "The bank file is e-mailed to these addresses." },
  accountsCc: { label: "CC", hint: "A copy goes to these addresses (optional)." },
};

/**
 * A list of e-mail addresses as chips: type one (or paste several) and press Enter, a comma or a space; × removes one.
 * Each address is checked as it is added; what is not an address stays in the box with the reason under it.
 */
function EmailListField({
  id,
  field,
  value,
  onChange,
  onPending,
  disabled,
  serverProblem,
}: {
  id: string;
  field: EmailField;
  value: string[];
  onChange: (next: string[]) => void;
  /** Whether text that is not added yet sits in the box (Save waits for it). */
  onPending: (field: EmailField, pending: boolean) => void;
  disabled: boolean;
  serverProblem?: string;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const typed = (next: string) => {
    setText(next);
    setProblem(null);
    onPending(field, next.trim() !== "");
  };

  const commit = () => {
    if (!text.trim()) return;
    const result = addEmails(value, text);
    if (result.list.length !== value.length) onChange(result.list);
    const left = result.rejected.join(" ");
    setText(left);
    setProblem(result.problem);
    onPending(field, left !== "");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";" || e.key === " ") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const { label, hint } = FIELD_TEXT[field];
  const shownProblem = problem ?? serverProblem ?? null;
  return (
    <div className="space-y-1.5" data-testid={`sl-field-${field}`}>
      <label htmlFor={id} className="text-xs font-semibold text-gray-700">
        {label}
      </label>
      <div
        className={cn(
          "flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border bg-white px-2 py-1.5",
          shownProblem ? "border-red-300" : "border-slate-200",
          disabled && "opacity-70",
        )}
      >
        {value.map((email) => (
          <span
            key={email}
            className="settings-chip inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium text-slate-700"
            data-testid={`sl-chip-${field}`}
          >
            {email}
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(removeEmail(value, email))}
                aria-label={`Remove ${email}`}
                className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        <Input
          id={id}
          value={text}
          disabled={disabled || value.length >= MAX_EMAILS}
          onChange={(e) => typed(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\s]/.test(pasted.trim())) {
              e.preventDefault();
              const result = addEmails(value, `${text} ${pasted}`);
              onChange(result.list);
              const left = result.rejected.join(" ");
              setText(left);
              setProblem(result.problem);
              onPending(field, left !== "");
            }
          }}
          placeholder={value.length >= MAX_EMAILS ? `${MAX_EMAILS} addresses at most` : "name@example.com"}
          aria-invalid={shownProblem ? true : undefined}
          aria-describedby={`${id}-help`}
          className="h-7 min-w-[12rem] flex-1 border-0 px-1 shadow-none focus-visible:ring-0"
          data-testid={`sl-input-${field}`}
        />
      </div>
      <p
        id={`${id}-help`}
        className={cn("text-xs leading-snug", shownProblem ? "font-medium text-red-600" : "text-gray-500")}
        role={shownProblem ? "alert" : undefined}
        data-testid={shownProblem ? `sl-problem-${field}` : undefined}
      >
        {shownProblem ?? `${hint} Press Enter or a comma after each one.`}
      </p>
    </div>
  );
}

function MethodStatus({ active, children }: { active: boolean; children?: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[13px]",
        active ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-white text-slate-600",
      )}
    >
      {active ? (
        <>
          <CheckCircle2 size={15} className="shrink-0 text-emerald-600" aria-hidden />
          <b>Active:</b> the Loan &amp; Advance pages run this method.
        </>
      ) : (
        <span>Not active.</span>
      )}
      {children}
    </div>
  );
}

/**
 * Settings -> Loan & Advance (owner 2026-11-26; Settlement until 2026-11-27): which method the Loan & Advance pages run, the Normal Method (approve / reject
 * each request, as always) or the Automation Method (the month-wise workflow HR -> MD -> HR -> auditor -> Accounts), and
 * the auditor's and Accounts' e-mail addresses the workflow sends its files to. One company-wide setting: only a login for
 * all units with the Settings edit right changes it.
 */
export default function SettlementTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const settings = useSettlementSettings();
  const update = useUpdateSettlementSettings();
  const data = settings.data;

  const [askedSub, setSub] = useState<SettlementSubTab | null>(() => SETTLEMENT_SUB_TAB_OF[addressSetting()] ?? null);
  const openSub = useCallback((s: SettlementSubTab) => setSub(s), []);
  useSubTabFromAddress(SETTLEMENT_SUB_TAB_OF, openSub);
  const sub: SettlementSubTab = askedSub ?? data?.method ?? "normal";

  const canChange = !readOnly && data?.canChange === true;
  const active = data?.method ?? "normal";

  // ── the method ──
  const [confirming, setConfirming] = useState<SettlementMethod | null>(null);
  const [switchProblem, setSwitchProblem] = useState<string | null>(null);

  const switchMethod = async (method: SettlementMethod) => {
    setSwitchProblem(null);
    try {
      await update.mutateAsync({ method });
      setConfirming(null);
      toast({
        title: `${METHOD_LABEL[method]} switched on`,
        description:
          method === "automation"
            ? "Loan & Advance is now the month-wise workflow. This month's waiting requests are in the first batch of their type."
            : "Loan & Advance approves and rejects each request on its own again.",
      });
    } catch (e) {
      const code = e instanceof ApiError ? (e.data as { code?: string } | null)?.code : undefined;
      setSwitchProblem(errorText(e) ?? "The method could not be changed.");
      if (code === "workflow_in_progress") void settings.refetch();
    }
  };

  // ── the e-mail addresses ──
  const saved = useMemo(() => emailFormOf(data), [data]);
  const [draft, setDraft] = useState<Partial<EmailForm>>({});
  const form: EmailForm = { ...saved, ...draft };
  const changes = changedEmails(saved, form);
  const dirty = Object.keys(changes).length > 0;
  const [pending, setPending] = useState<Partial<Record<EmailField, boolean>>>({});
  const [serverProblem, setServerProblem] = useState<{ field?: string; text: string } | null>(null);
  const setList = (field: EmailField, next: string[]) => {
    setDraft((d) => ({ ...d, [field]: next }));
    setServerProblem(null);
  };
  const onPending = useCallback(
    (field: EmailField, isPending: boolean) =>
      setPending((p) => (p[field] === isPending ? p : { ...p, [field]: isPending })),
    [],
  );
  const typing = EMAIL_FIELDS.some((f) => pending[f]);
  const ccProblem = ccWithoutTo(form);

  // ── how long the auditor's review link works (2026-11-27) ──
  const limits = data?.auditorLinkDaysLimits ?? LINK_DAYS_LIMITS;
  const savedDays = data?.auditorLinkDays ?? limits.default;
  const [daysDraft, setDaysDraft] = useState<string | null>(null);
  const daysText = daysDraft ?? String(savedDays);
  const daysProblem = daysDraft === null ? null : linkDaysProblem(daysDraft, limits);
  const daysDirty = daysDraft !== null && !daysProblem && Number(daysDraft) !== savedDays;
  const anyDirty = dirty || daysDirty;

  const saveEmails = async () => {
    if (!anyDirty || daysProblem) return;
    try {
      await update.mutateAsync({ ...changes, ...(daysDirty ? { auditorLinkDays: Number(daysDraft) } : {}) });
      setDraft({});
      setDaysDraft(null);
      setServerProblem(null);
      toast({
        title: "Loan & Advance settings saved",
        description: "The next review link and file the workflow sends use them.",
      });
    } catch (e) {
      const body = e instanceof ApiError ? (e.data as { field?: string } | null) : null;
      setServerProblem({ field: body?.field, text: errorText(e) ?? "The addresses could not be saved." });
      toast({ title: "Couldn't save the addresses", description: errorText(e), variant: "destructive" });
    }
  };

  if (settings.isError && !data) {
    return (
      <div className="settings-glass rounded-xl p-6 text-sm text-slate-600" data-testid="sl-error">
        <p className="font-semibold text-slate-900">The Loan &amp; Advance settings could not be loaded.</p>
        <p className="mt-1">{errorText(settings.error) ?? "Check the connection and try again."}</p>
        <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={() => void settings.refetch()}>
          <RefreshCw size={13} /> Try again
        </Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3" data-testid="sl-loading">
        <Skeleton className="h-12 w-72 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const inProgress = data.inProgress ?? [];
  const switchBox = (method: SettlementMethod) =>
    confirming === method && (
      <div
        className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900"
        role="alertdialog"
        aria-label={`Switch to the ${METHOD_LABEL[method]}`}
        data-testid={`sl-confirm-${method}`}
      >
        <p className="flex items-start gap-2 font-semibold">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          Switch Loan &amp; Advance to the {METHOD_LABEL[method]}?
        </p>
        <p className="mt-1 text-[12px] leading-snug">
          {method === "automation"
            ? "From now on every Salary Advance and Term Loan goes through the workflow of its type: approving or rejecting one on the Loan & Advance pages or the Requests page is refused, and the MD decides each forwarded request. Requests already decided stay as they are."
            : "HR approves and rejects each request on its own again. Requests still waiting are decided one by one."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            disabled={update.isPending}
            onClick={() => void switchMethod(method)}
            data-testid={`sl-confirm-${method}-button`}
          >
            {update.isPending ? "Switching…" : `Switch to the ${METHOD_LABEL[method]}`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => {
              setConfirming(null);
              setSwitchProblem(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );

  const methodButton = (method: SettlementMethod) =>
    active !== method && (
      <Button
        size="sm"
        className="gap-1.5"
        disabled={!canChange || confirming !== null || update.isPending}
        onClick={() => {
          setSwitchProblem(null);
          setConfirming(method);
        }}
        title={canChange ? undefined : "Only a login for all units with the Settings edit right can change it."}
        data-testid={`sl-use-${method}`}
      >
        Use this method
      </Button>
    );

  const problemBox = switchProblem && (
    <div
      className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-800"
      role="alert"
      data-testid="sl-switch-error"
    >
      <p className="font-semibold">{switchProblem}</p>
      {inProgress.length > 0 && (
        <ul className="list-disc pl-4">
          {inProgress.map((b) => (
            <li key={b.id}>{inProgressText(b)}</li>
          ))}
        </ul>
      )}
    </div>
  );

  // the tab's ONE row of sub-tabs (owner 2026-11-27): the two methods, then the two sets of rules
  const subItems = [
    ...(["normal", "automation"] as const).map((m) => ({
      value: m,
      label: (
        <span className="inline-flex items-center gap-1.5">
          {METHOD_LABEL[m]}
          {active === m && (
            <span className="rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-800">Active</span>
          )}
        </span>
      ),
      icon: m === "normal" ? <Scale size={13} /> : <Workflow size={13} />,
    })),
    { value: "sa_rules", label: "Salary Advance Rules", icon: <Banknote size={13} /> },
    { value: "tl_rules", label: "Term Loan Rules", icon: <Landmark size={13} /> },
  ];
  const methodSub = sub === "normal" || sub === "automation";

  return (
    <div className="space-y-4">
      <div className="max-w-full overflow-x-auto" data-testid="sl-subtabs">
        <PillTabs
          items={subItems}
          value={sub}
          onChange={(v) => {
            setSub(v as SettlementSubTab);
            setConfirming(null);
            setSwitchProblem(null);
          }}
          baseColor="#0f172a"
          pillBg="#f1f5f9"
          size="sm"
        />
      </div>

      {sub === "sa_rules" && <SalaryAdvanceRulesForm data={data} canChange={canChange} readOnly={readOnly} />}
      {sub === "tl_rules" && <TermLoanRulesForm data={data} canChange={canChange} readOnly={readOnly} />}

      {methodSub && (
        <SettingsSection
          icon={Workflow}
          title="Loan & Advance method"
          purpose="How Salary Advances and Term Loans are decided on the Loan & Advance pages. Choose one method; the other is switched off."
          testId="sl-summary"
        >
          <p
            className="settings-clay-inset rounded-xl px-4 py-3 text-[14px] leading-relaxed text-slate-800"
            aria-live="polite"
            data-testid="sl-active"
          >
            Loan &amp; Advance runs the <b>{METHOD_LABEL[active]}</b>.
            {data.updatedBy && data.updatedAt && (
              <span className="mt-1 block text-[12px] text-slate-500" data-testid="sl-updated">
                Last changed by {data.updatedBy} on {new Date(data.updatedAt).toLocaleString("en-IN")}.
              </span>
            )}
          </p>
          {!canChange && !readOnly && (
            <p className="mt-2 text-[12px] text-slate-500" data-testid="sl-read-only">
              View only: the method and the addresses are one company-wide setting, changed by a login for all units
              with the Settings edit right.
            </p>
          )}
          {sub === "normal" && (
            <SettingBlock
              {...meta("sl-normal")}
              affects={NORMAL_AFFECTS}
              defaultText="Normal Method"
              testId="sl-normal"
            >
              <MethodStatus active={active === "normal"} />
              <ul className="list-disc space-y-1 pl-5 text-[13px] leading-snug text-slate-600">
                <li>Each request is approved (the amount asked for or less) or rejected on its own, with a remark.</li>
                <li>The deduction schedule is made when it is approved; the employee is told at once.</li>
                <li>The report and the bank file are exported from the Loan &amp; Advance pages when HR wants them.</li>
              </ul>
              {active === "automation" && inProgress.length > 0 && (
                <div
                  className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900"
                  data-testid="sl-in-progress"
                >
                  <p className="font-semibold">
                    Switching back is refused while a batch is in progress. Complete these first:
                  </p>
                  <ul className="mt-1 list-disc pl-4">
                    {inProgress.map((b) => (
                      <li key={b.id}>{inProgressText(b)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {methodButton("normal")}
              {switchBox("normal")}
              {problemBox}
            </SettingBlock>
          )}

          {sub === "automation" && (
            <SettingBlock
              {...meta("sl-automation")}
              affects={AUTOMATION_AFFECTS}
              note="Only HR's and the MD's clicks move a batch: nothing is decided, sent or paid by itself."
              testId="sl-automation"
            >
              <MethodStatus active={active === "automation"} />
              <div className="settings-clay-inset p-3.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  <ListChecks size={12} aria-hidden /> The workflow, every month
                </p>
                <ol className="mt-2 space-y-1 text-[13px] text-slate-700" data-testid="sl-stages">
                  {STAGES.map((s, i) => (
                    <li key={s} className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-700">
                        {i + 1}
                      </span>
                      {s}
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[12px] leading-snug text-slate-500">
                  A request raised after HR forwarded a batch waits in the month&apos;s next batch. HR&apos;s final
                  settlement stays within the MD&apos;s decision. Each request shows its leave check: orange for 3 days
                  of leave in the days the earned salary counts (Salary Advance Rules), red for more.
                </p>
              </div>
              {methodButton("automation")}
              {switchBox("automation")}
              {problemBox}
            </SettingBlock>
          )}
        </SettingsSection>
      )}

      {sub === "automation" && (
        <SettingsSection
          icon={Mail}
          title="Where the files go"
          purpose="The Automation Method e-mails the auditor a secure link to the Auditor Review Portal (with the finalized report attached) and the bank file to Accounts, through Gmail Control. The wording of both e-mails is edited in Gmail Control."
          testId="sl-emails"
        >
          {(["auditor", "accounts"] as const).map((who) => {
            const to: EmailField = who === "auditor" ? "auditorEmails" : "accountsEmails";
            const cc: EmailField = who === "auditor" ? "auditorCc" : "accountsCc";
            return (
              <SettingBlock key={who} {...meta(who === "auditor" ? "sl-auditor" : "sl-accounts")}>
                {[to, cc].map((field) => (
                  <EmailListField
                    key={field}
                    id={`sl-${field}`}
                    field={field}
                    value={form[field]}
                    onChange={(next) => setList(field, next)}
                    onPending={onPending}
                    disabled={!canChange}
                    serverProblem={serverProblem?.field === field ? serverProblem.text : undefined}
                  />
                ))}
              </SettingBlock>
            );
          })}
          <SettingBlock {...meta("sl-link-days")}>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="sl-auditorLinkDays" className="text-[13px] text-slate-700">
                Review link valid for
              </Label>
              <Input
                id="sl-auditorLinkDays"
                type="number"
                inputMode="numeric"
                min={limits.min}
                max={limits.max}
                step={1}
                value={daysText}
                onChange={(e) => {
                  setDaysDraft(e.target.value);
                  setServerProblem(null);
                }}
                disabled={!canChange}
                className="h-9 w-24"
                aria-invalid={!!daysProblem || serverProblem?.field === "auditorLinkDays"}
                aria-describedby="sl-auditorLinkDays-help"
                data-testid="sl-link-days"
              />
              <span className="text-[13px] text-slate-600">days</span>
            </div>
            <p id="sl-auditorLinkDays-help" className="mt-1 text-[12px] text-slate-500">
              {limits.min} to {limits.max} days ({limits.default} by default). A new Send to Auditor replaces the older
              link; a link stops working once the auditor answers.
            </p>
            {(daysProblem || serverProblem?.field === "auditorLinkDays") && (
              <p className="mt-1 text-xs font-medium text-red-600" role="alert" data-testid="sl-link-days-problem">
                {daysProblem ?? serverProblem?.text}
              </p>
            )}
          </SettingBlock>
          {serverProblem && !serverProblem.field && (
            <p className="text-xs font-medium text-red-600" role="alert">
              {serverProblem.text}
            </p>
          )}
          {ccProblem && (
            <p className="mt-2 text-xs font-medium text-amber-700" data-testid="sl-cc-problem">
              {ccProblem}
            </p>
          )}
        </SettingsSection>
      )}

      {sub === "automation" && (
        <SaveFooter
          dirty={anyDirty || !!daysProblem}
          saving={update.isPending && confirming === null}
          onSave={() => void saveEmails()}
          onDiscard={() => {
            setDraft({});
            setDaysDraft(null);
            setServerProblem(null);
          }}
          saveLabel="Save Loan & Advance Settings"
          disabled={!canChange || !anyDirty || typing || !!daysProblem}
          hint={
            !canChange && !readOnly
              ? "Company-wide: only a login for all units with the Settings edit right can change it."
              : typing
                ? "Press Enter to add the address you typed (or clear it) before saving."
                : anyDirty
                  ? "Unsaved changes - the workflow keeps using the saved addresses and link days until you save."
                  : undefined
          }
        />
      )}
    </div>
  );
}
