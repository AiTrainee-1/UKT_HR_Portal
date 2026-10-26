import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, Factory, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
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
import {
  isPfEsiForbidden,
  isStalePfEsiError,
  pfEsiErrorMessage,
  pfEsiRuleProblem,
  useResetPfEsiBranch,
  usePfEsiSettings,
  useUpdatePfEsiSettings,
  type PfEsiRuleProblem,
  type PfEsiSettings,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ConfirmSave } from "./attendance/ConfirmSave";
import { useDraft } from "./attendance/useDraft";
import { SaveBar } from "./kit/SaveBar";
import { SaveDock } from "./kit/SaveDock";
import { SettingBlock } from "./kit/SettingBlock";
import { setUnsavedGuard } from "./kit/leaveGuard";
import { addressSetting, useSubTabFromAddress } from "./payroll/form";
import { PF_ESI_SUB_TAB_OF, pfEsiText, type PfEsiSubTab } from "./PfEsiTab.meta";
import { ClassPage } from "./pf-esi/ClassPage";
import {
  CLASS_LABEL,
  DEFAULT_MAX_RULES,
  changeLines,
  classOf,
  draftFrom,
  problemClasses,
  sameDraft,
  toInput,
  validateDraft,
  withServerProblem,
  type RuleClass,
  type RuleDraft,
} from "./pf-esi/form";

const SUB_TABS: { value: PfEsiSubTab; label: string; icon: ReactNode }[] = [
  { value: "staff", label: "Staff", icon: <Users size={13} /> },
  { value: "production", label: "Production", icon: <Factory size={13} /> },
];

const READ_ONLY_TEXT = "Only the Super Admin can change PF/ESI rules. Showing the rules that apply to your unit.";
const STALE_TEXT =
  "Someone else saved these rules while you were editing. Reload to see their changes; your edits are kept until you reload.";

/** What went wrong with a save, in words an HR manager can act on. */
function failureText(err: unknown): string {
  if (isStalePfEsiError(err)) return STALE_TEXT;
  const problem = pfEsiRuleProblem(err);
  if (problem) return problem.message;
  if (isPfEsiForbidden(err)) return "Only the Super Admin can change PF / ESI rules.";
  return pfEsiErrorMessage(err) ?? "The PF & ESI rules could not be saved. Check the connection and try again.";
}

const LOAD_ERROR =
  "flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800";

/**
 * Settings -> PF & ESI. Two pages (Staff, Production), each with a PF list and an ESI list of rules (a salary range measured
 * on a basis, and a percentage), one Save for all four. Only employees switched ON in Employees, Co Emp can ever pay PF or
 * ESI. The Super Admin edits the all-units rules and can give a unit (branch) a rule set of its own, reset again to follow the
 * all-units rules; every other login sees, read-only, the rules that apply to its own unit.
 */
export default function PfEsiTab({ readOnly = false }: { readOnly?: boolean }) {
  const [branchId, setBranchId] = useState<number | null>(null);
  const query = usePfEsiSettings(branchId);
  const data = query.data;
  const switching = query.isPlaceholderData;

  const [subTab, setSubTab] = useState<PfEsiSubTab>(() => PF_ESI_SUB_TAB_OF[addressSetting()] ?? "staff");
  useSubTabFromAddress(PF_ESI_SUB_TAB_OF, setSubTab);

  // unsaved edits in the open scope: leaving the tab or changing scope asks first
  const dirtyRef = useRef(false);
  const reportDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  useEffect(() => {
    setUnsavedGuard(() => dirtyRef.current);
    return () => setUnsavedGuard(null);
  }, []);

  const [pendingScope, setPendingScope] = useState<number | null | undefined>(undefined);
  const goToScope = (next: number | null) => {
    dirtyRef.current = false;
    setBranchId(next);
    setPendingScope(undefined);
  };
  const chooseScope = (next: number | null) => {
    if (next === branchId) return;
    if (dirtyRef.current) setPendingScope(next);
    else goToScope(next);
  };

  // a reset to global remounts the editor on the branch's new (global) rules
  const [resets, setResets] = useState(0);

  if (query.isLoading || (!data && !query.isError)) {
    return (
      <div className="space-y-3" data-testid="pf-esi-loading">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className={LOAD_ERROR} data-testid="pf-esi-load-error">
        The PF &amp; ESI rules could not be loaded.
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
        {branchId !== null && (
          <Button size="sm" variant="outline" onClick={() => goToScope(null)}>
            Back to the all-units rules
          </Button>
        )}
      </div>
    );
  }

  const canEdit = data.canEdit && !readOnly;

  return (
    <div className="space-y-4" data-testid="pf-esi-tab">
      {!data.canEdit && (
        <div
          className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-medium text-amber-800"
          data-testid="pf-esi-readonly"
        >
          <Eye size={15} />
          {READ_ONLY_TEXT}
        </div>
      )}

      <ScopeBlock
        data={data}
        chosen={branchId}
        switching={switching}
        onChoose={chooseScope}
        canEdit={canEdit}
        onReset={() => {
          setResets((n) => n + 1);
          dirtyRef.current = false;
        }}
      />

      {switching ? (
        <div className="space-y-3" data-testid="pf-esi-scope-loading">
          <Skeleton className="h-10 w-48 rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : (
        <PfEsiEditor
          key={`${branchId ?? "global"}:${resets}`}
          data={data}
          locked={!canEdit}
          subTab={subTab}
          onSubTab={setSubTab}
          onDirty={reportDirty}
          reload={async () => (await query.refetch()).data}
        />
      )}

      <AlertDialog open={pendingScope !== undefined} onOpenChange={(open) => !open && setPendingScope(undefined)}>
        <AlertDialogContent data-testid="pf-esi-switch-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to another set of rules?</AlertDialogTitle>
            <AlertDialogDescription>
              You changed these rules and have not saved them. If you switch now, those changes are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              data-testid="pf-esi-switch-confirm-yes"
              onClick={() => pendingScope !== undefined && goToScope(pendingScope)}
            >
              Switch and lose my changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── whose rules ──

/**
 * "Whose rules these are": for the Super Admin the picker between the all-units rules and each unit's (with a badge on the
 * units that have rules of their own), what saving will do, and Reset to global for a unit with its own rules; for every
 * other login one sentence saying which rules it is looking at.
 */
function ScopeBlock({
  data,
  chosen,
  switching,
  onChoose,
  canEdit,
  onReset,
}: {
  data: PfEsiSettings;
  chosen: number | null;
  switching: boolean;
  onChoose: (branchId: number | null) => void;
  canEdit: boolean;
  onReset: () => void;
}) {
  const { toast } = useToast();
  const reset = useResetPfEsiBranch();
  const [confirming, setConfirming] = useState(false);
  const picker = data.canEdit && data.branches.length > 0;
  const { scope } = data;
  const branchName = scope.branchName ?? data.branches.find((b) => b.id === scope.branchId)?.name ?? "this branch";

  const doReset = async () => {
    setConfirming(false);
    if (scope.branchId === null) return;
    try {
      await reset.mutateAsync(scope.branchId);
      onReset();
      toast({
        title: `${branchName} follows the all-units rules again`,
        description: "Its own rule set is removed. Payslips already generated are never changed.",
      });
    } catch (err) {
      toast({
        title: "Failed to reset to the all-units rules",
        description: pfEsiErrorMessage(err) ?? "Check the connection and try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="settings-glass rounded-xl p-4 sm:p-6" data-testid="pf-esi-scope-card">
      <SettingBlock
        {...{ id: "pf-esi-scope", ...pfEsiText("pf-esi-scope") }}
        affects={[
          {
            where: "Staff Payroll and Production Payroll",
            what: "payroll of a unit's employees uses that unit's own rules when it has them, else the all-units rules.",
            to: "/hr/payroll",
          },
          {
            where: "Every login",
            what: "shows, read-only, the rules that apply to its own unit; only the Super Admin can change them.",
          },
        ]}
        className="lg:grid-cols-1"
      >
        {picker ? (
          <div className="space-y-3">
            <div
              role="radiogroup"
              aria-label="Whose rules"
              className="flex flex-wrap gap-2"
              data-testid="pf-esi-scope-picker"
            >
              <ScopeOption
                id="global"
                label="All units (global)"
                checked={chosen === null}
                onClick={() => onChoose(null)}
              />
              {data.branches.map((b) => (
                <ScopeOption
                  key={b.id}
                  id={String(b.id)}
                  label={b.name}
                  checked={chosen === b.id}
                  badge={b.hasOverride}
                  onClick={() => onChoose(b.id)}
                />
              ))}
            </div>

            {switching ? null : scope.branchId === null ? (
              <p className="text-[13px] leading-snug text-gray-600" data-testid="pf-esi-global-notice">
                These are the all-units rules: they apply to every unit that has no rule set of its own, and every login
                can see them.
              </p>
            ) : scope.isOverride ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5"
                data-testid="pf-esi-own-notice"
              >
                <p className="min-w-0 flex-1 text-[13px] leading-snug text-gray-700">
                  <strong>{branchName}</strong> has its own rule set. It replaces the all-units rules for this unit's
                  employees and logins.
                </p>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-300 text-rose-700 hover:bg-rose-50"
                    disabled={reset.isPending}
                    onClick={() => setConfirming(true)}
                    data-testid="pf-esi-reset"
                  >
                    Reset to global
                  </Button>
                )}
              </div>
            ) : (
              <p
                className="rounded-lg bg-amber-50 px-3 py-2.5 text-[13px] leading-snug text-amber-900 ring-1 ring-amber-200"
                data-testid="pf-esi-inherit-notice"
              >
                <strong>{branchName}</strong> is following global rules - saving creates this branch's own rule set.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[13px] leading-snug text-gray-700" data-testid="pf-esi-scope-text">
            {scope.branchId === null
              ? data.canEdit
                ? "You are editing the all-units rules. They apply to every unit and show in every login."
                : "Showing the all-units rules, which apply to your unit."
              : scope.isOverride
                ? `Showing ${branchName}'s own rule set.`
                : `Showing the all-units rules that ${branchName} follows.`}
          </p>
        )}

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent data-testid="pf-esi-reset-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Reset {branchName} to the all-units rules?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    {branchName}'s own rule set (all four lists) is deleted. From the next payroll generated its
                    employees follow the all-units rules, and so will the logins of this unit.
                  </p>
                  <p>
                    Payslips already generated are never changed. Any edits you have not saved are dropped. This cannot
                    be undone.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep its own rules</AlertDialogCancel>
              <AlertDialogAction data-testid="pf-esi-reset-confirm-yes" onClick={() => void doReset()}>
                Reset to global
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingBlock>
    </div>
  );
}

function ScopeOption({
  id,
  label,
  checked,
  badge,
  onClick,
}: {
  id: string;
  label: string;
  checked: boolean;
  badge?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      data-testid={`pf-esi-scope-${id}`}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium",
        checked
          ? "border-[#006496] bg-[#eff6fb] text-[#004f78]"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
      )}
    >
      {label}
      {badge && (
        <span
          className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200"
          data-testid={`pf-esi-own-badge-${id}`}
        >
          own rules
        </span>
      )}
    </button>
  );
}

// ── the rules of one scope ──

type ServerProblem = { draft: RuleDraft; problem: PfEsiRuleProblem };

/**
 * The editor of one scope's four lists, with its pills, its one Save and its stale-version handling. It is remounted for
 * every scope, so its draft always belongs to the rules it was opened on.
 */
function PfEsiEditor({
  data,
  locked,
  subTab,
  onSubTab,
  onDirty,
  reload: refetchSaved,
}: {
  data: PfEsiSettings;
  locked: boolean;
  subTab: PfEsiSubTab;
  onSubTab: (tab: PfEsiSubTab) => void;
  onDirty: (dirty: boolean) => void;
  reload: () => Promise<PfEsiSettings | undefined>;
}) {
  const { toast } = useToast();
  const update = useUpdatePfEsiSettings();
  const saved = useMemo(() => draftFrom(data), [data]);
  const { draft, setDraft, update: patchDraft, dirty, discard } = useDraft(saved, sameDraft);
  const maxRules = data.limits?.maxRulesPerList ?? DEFAULT_MAX_RULES;
  const checked = useMemo(() => (draft ? validateDraft(draft, maxRules) : null), [draft, maxRules]);

  // the `version` the draft started from: a save sends it back, so a copy somebody else has outdated is refused
  const [baseVersion, setBaseVersion] = useState(data.version);
  const [seenSaved, setSeenSaved] = useState(saved);
  if (saved !== seenSaved) {
    setSeenSaved(saved);
    if (draft === null || sameDraft(draft, seenSaved)) setBaseVersion(data.version);
  }

  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirmingReload, setConfirmingReload] = useState(false);
  const [serverProblem, setServerProblem] = useState<ServerProblem | null>(null);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  if (!draft || !checked) return null;

  // the server's own word about a row, kept only while the draft is the one it refused
  const validation =
    serverProblem && serverProblem.draft === draft ? withServerProblem(checked, serverProblem.problem) : checked;
  const canSave = !locked && dirty && validation.ok;
  const attention = problemClasses(validation);
  const changes = changeLines(draft, saved);
  const scope = data.scope;
  const branchName = scope.branchName ?? "this branch";

  const save = async () => {
    setConfirming(false);
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setStale(false);
    setServerProblem(null);
    try {
      const result = await update.mutateAsync(
        toInput(draft, saved, { branchId: scope.branchId, expectedVersion: baseVersion }),
      );
      setDraft(draftFrom(result));
      setBaseVersion(result.version);
      toast({
        title: "PF & ESI rules saved",
        description:
          scope.branchId === null
            ? "Payroll generated from now on uses them for every unit without a rule set of its own. Payslips already generated are never changed."
            : `Payroll of ${branchName}'s employees generated from now on uses them. Payslips already generated are never changed.`,
      });
    } catch (err) {
      const problem = pfEsiRuleProblem(err);
      if (problem) {
        setServerProblem({ draft, problem });
        if (problem.list) onSubTab(classOf(problem.list));
      }
      if (isStalePfEsiError(err)) setStale(true);
      const message = failureText(err);
      setSaveError(message);
      toast({ title: "Failed to save the PF & ESI rules", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // read the rules again and start the form from them: whatever was typed is dropped
  const reload = async () => {
    setConfirmingReload(false);
    const fresh = await refetchSaved();
    if (!fresh) return;
    setDraft(draftFrom(fresh));
    setBaseVersion(fresh.version);
    setSaveError(null);
    setStale(false);
    setServerProblem(null);
  };

  const hint = locked
    ? "View only: the rules cannot be changed from this login."
    : validation.first
      ? `Fix this first: ${validation.first}`
      : undefined;

  const consequences = [
    scope.branchId === null
      ? "These rules apply to every unit that has no rule set of its own."
      : scope.isOverride
        ? `These rules apply to ${branchName} only.`
        : `This creates ${branchName}'s own rule set: all four lists become that unit's own, and later changes to the all-units rules no longer reach it.`,
    "They are used the next time payroll is generated, for employees switched ON in Co Emp only. Payslips already generated are never changed.",
    "An employee who fits no rule of a list pays nothing of that kind.",
  ];

  return (
    <div className="space-y-4" data-testid="pf-esi-editor" data-scope={scope.branchId ?? "global"}>
      <div className="flex flex-wrap items-center gap-3" data-testid="pf-esi-subtabs">
        <PillTabs
          items={SUB_TABS}
          value={subTab}
          onChange={(v) => onSubTab(v as PfEsiSubTab)}
          baseColor="#0f172a"
          pillBg="#f1f5f9"
        />
        {dirty && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
            Not saved yet
          </span>
        )}
        {attention.length > 0 && (
          <span
            className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-800 ring-1 ring-red-200"
            data-testid="pf-esi-attention"
          >
            Needs attention: {attention.map((c: RuleClass) => CLASS_LABEL[c]).join(", ")}
          </span>
        )}
      </div>

      <ClassPage
        key={subTab}
        cls={subTab}
        draft={draft}
        validation={validation}
        onList={(key, rows) => patchDraft({ [key]: rows })}
        settings={data}
        locked={locked}
      />

      {!locked && (
        <SaveDock>
          {saveError && (
            <div
              role="alert"
              className="mb-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              data-testid="pf-esi-save-error"
            >
              {saveError}
              {stale && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="pf-esi-reload"
                    onClick={() => (dirty ? setConfirmingReload(true) : void reload())}
                  >
                    Reload the saved rules
                  </Button>
                </div>
              )}
            </div>
          )}
          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={() => setConfirming(true)}
            onDiscard={() => {
              setSaveError(null);
              setServerProblem(null);
              discard();
            }}
            saveLabel="Save PF & ESI Rules"
            disabled={!canSave}
            hint={hint}
          />
        </SaveDock>
      )}

      <AlertDialog open={confirmingReload} onOpenChange={setConfirmingReload}>
        <AlertDialogContent data-testid="pf-esi-reload-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Reload and drop your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              Reloading shows the rules as they are saved now, including what the other person changed. Everything you
              have changed here and not saved is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction data-testid="pf-esi-reload-confirm-yes" onClick={() => void reload()}>
              Reload and drop my edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmSave
        open={confirming}
        onOpenChange={setConfirming}
        title="Save these PF & ESI rules?"
        changes={changes}
        testId="confirm-pf-esi"
        onConfirm={() => void save()}
        consequences={consequences}
      />
    </div>
  );
}
