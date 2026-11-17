import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import {
  Briefcase,
  Clock,
  Eraser,
  Factory,
  ListChecks,
  Search,
  Smartphone,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import DataPagination from "@/components/ui/DataPagination";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAuth } from "@/contexts/AuthContext";
import { useDraft } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import {
  getListBranchesQueryKey,
  useChangeRecipients,
  useListBranches,
  usePhoneAlertSettings,
  useRecipientEmployees,
  useRecipients,
  useSavePhoneAlertSettings,
  useSetRecipientMode,
  type AlertTimingKey,
  type PushRecipients,
  type RecipientEmployee,
  type RecipientMode,
  type RecipientModeOption,
} from "@/lib/api-client/custom-hooks";
import { categoryForEmploymentType, departmentOptions, keepIfOffered, useOrgDepartments } from "@/lib/departments";
import { OrgNativeOptions } from "@/lib/org-select";
import { cn } from "@/lib/utils";
import {
  ALERT_TIMING_KEYS,
  RECIPIENT_PAGE_SIZE,
  alertTimingChanges,
  alertTimingDraft,
  alertTimingProblem,
  alertTimingRange,
  asId,
  asPage,
  asPickerShow,
  asPickerType,
  bulkChange,
  bulkQuestion,
  changeDoneText,
  employeesText,
  errorText,
  formatNumber,
  formatWhen,
  modeBlocked,
  modeChange,
  modeLabel,
  recipientParams,
  recipientsLine,
  type AlertTimingDraft,
  type BulkKind,
  type PickerFilters,
} from "./logic";
import { FilterChips, InlineConfirm, LoadError, Notice, Panel, useLockedWhy } from "./ui";

type IconType = ComponentType<{ size?: number; className?: string }>;

const MODE_ICON: Record<RecipientMode, IconType> = {
  all: Users,
  staff: Briefcase,
  production: Factory,
  selected: ListChecks,
};

const SELECT = "h-8 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-xs text-foreground";

// The picker's filters live in the address (?q=asha&type=staff&branch=2&dept=5&list=on&page=2), like the other tabs'.
type PickerUrl = { q: string; type: string; branch: string; dept: string; list: string; page: string };
const URL_DEFAULTS: PickerUrl = { q: "", type: "", branch: "", dept: "", list: "all", page: "1" };

/** Where "Go to the list" lands: the picker, with its search box focused. */
const PICKER_ID = "pn-recipient-picker";
const PICKER_SEARCH_ID = "pn-recipient-search-box";

function goToPicker() {
  document.getElementById(PICKER_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById(PICKER_SEARCH_ID)?.focus({ preventScroll: true });
}

// ── who receives ──────────────────────────────────────────────────────────────

function ModeCard({
  option,
  current,
  picked,
  emptyList,
  disabled,
  locked,
  onPick,
}: {
  option: RecipientModeOption;
  current: boolean;
  picked: boolean;
  emptyList: boolean;
  disabled: boolean;
  locked: string | null;
  onPick: () => void;
}) {
  const Icon = MODE_ICON[option.key] ?? Users;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={picked}
      tabIndex={picked ? 0 : -1}
      disabled={disabled}
      title={locked ?? undefined}
      onClick={onPick}
      data-testid={`pn-mode-${option.key}`}
      data-current={current ? "true" : "false"}
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-2xl border-2 bg-card p-4 text-left text-card-foreground shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        picked
          ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
          : "border-border hover:border-indigo-300",
        !current && picked && "border-dashed",
        disabled && "cursor-not-allowed",
      )}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span
            className={cn(
              "shrink-0 rounded-lg p-1.5",
              picked
                ? "bg-indigo-600 text-white"
                : "bg-muted text-muted-foreground dark:bg-slate-800 dark:text-slate-300",
            )}
          >
            <Icon size={16} />
          </span>
          <span className="min-w-0 break-words">{option.label}</span>
        </span>
        {/* the radio's own dot, so the choice does not rest on colour alone */}
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
            picked ? "border-indigo-600 dark:border-indigo-400" : "border-gray-300 dark:border-slate-500",
          )}
        >
          {picked && <span className="h-2 w-2 rounded-full bg-indigo-600 dark:bg-indigo-400" />}
        </span>
      </span>
      {option.description && <span className="text-xs leading-snug text-muted-foreground">{option.description}</span>}
      {(current || (picked && !current) || emptyList) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {current && <StatusBadge tone="success">In use now</StatusBadge>}
          {picked && !current && <StatusBadge tone="accent">Chosen, not saved yet</StatusBadge>}
          {emptyList && (
            <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
              The list is empty: tick employees below first
            </span>
          )}
        </span>
      )}
      <span className="mt-auto pt-1 text-xs" data-testid={`pn-mode-reach-${option.key}`}>
        <b className="tabular-nums">{employeesText(option.employees)}</b>
        <span className="text-muted-foreground">, {formatNumber(option.withPhone)} with a phone</span>
      </span>
    </button>
  );
}

/** Left / Right / Up / Down / Home / End move between the choices and pick the one they land on (nothing is saved). */
function onRadioKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')];
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || radios.length === 0) return;
  event.preventDefault();
  const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
  const to =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (at + (forward ? 1 : -1) + radios.length) % radios.length;
  radios[to].focus();
  radios[to].click();
}

function ModePanel({ r, locked }: { r: PushRecipients; locked: string | null }) {
  const { toast } = useToast();
  const save = useSetRecipientMode();
  const [chosen, setChosen] = useState<RecipientMode | null>(null);
  // a choice that is the mode already (just saved, or changed in another window) asks nothing
  const pending = chosen && chosen !== r.mode ? chosen : null;
  const blocked = pending ? modeBlocked(pending, r) : null;
  const change = pending && !blocked ? modeChange(r.mode, pending, r.modes) : null;
  const shown = pending ?? r.mode;
  const line = recipientsLine(r);
  // on a phone the question opens below all four cards: bring it into view
  const askRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) askRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [pending]);

  const doSave = (mode: RecipientMode) =>
    save.mutate(mode, {
      onSuccess: (d) => {
        setChosen(null);
        toast({
          title: `Phone notifications now go to: ${modeLabel(d.mode, d.modes)}`,
          description: `${employeesText(d.receiving)}, ${formatNumber(d.receivingWithPhone)} with a phone.`,
        });
      },
      onError: (e) =>
        toast({ title: "Could not change that", description: errorText(e, "Try again."), variant: "destructive" }),
    });

  return (
    <Panel
      title="Who receives phone notifications"
      icon={Users}
      testId="pn-recipient-modes"
      description="The HRMS checks this before it makes any automatic notification. Employees left out get no phone notification and no notification in their app; their requests, payslips and chat keep working. A message HR sends from the Send tab still goes to whoever HR picks."
    >
      <div
        className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border bg-muted px-3 py-2 text-[13px]"
        data-testid="pn-recipients-summary"
      >
        <span>
          Phone notifications go to: <b>{line.label}</b> — {line.reach}
        </span>
        {r.updatedBy && (
          <span className="text-[11px] text-muted-foreground" data-testid="pn-recipients-updated">
            Last changed by {r.updatedBy} on {formatWhen(r.updatedAt)}
          </span>
        )}
      </div>

      {r.mode === "selected" && r.selected === 0 && (
        <Notice tone="warn" testId="pn-recipients-nobody" className="mb-3">
          Nobody gets phone notifications now: the choice is <b>Selected employees</b> and the list below is empty.
        </Notice>
      )}

      <div
        role="radiogroup"
        aria-label="Who receives phone notifications"
        onKeyDown={onRadioKeys}
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        data-testid="pn-mode-options"
      >
        {r.modes.map((m) => (
          <ModeCard
            key={m.key}
            option={m}
            current={m.key === r.mode}
            picked={m.key === shown}
            emptyList={m.key === "selected" && r.selected === 0}
            disabled={locked !== null || save.isPending}
            locked={locked}
            onPick={() => setChosen(m.key)}
          />
        ))}
      </div>

      <div ref={askRef} className="scroll-mb-4">
        {pending && blocked && (
          <Notice tone="warn" role="alert" testId="pn-mode-blocked" className="mt-3">
            <p>{blocked}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setChosen(null);
                  goToPicker();
                }}
                data-view-safe
                data-testid="pn-mode-blocked-go"
              >
                Go to the list
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setChosen(null)} data-view-safe>
                Cancel
              </Button>
            </div>
          </Notice>
        )}

        {pending && change && (
          <InlineConfirm
            testId="pn-confirm-mode"
            className="mt-3"
            stacked
            confirmLabel={`Save: ${modeLabel(pending, r.modes)}`}
            destructive={change.stops}
            pending={save.isPending}
            onConfirm={() => doSave(pending)}
            onCancel={() => setChosen(null)}
          >
            <p className="font-semibold">
              Change who receives phone notifications from {modeLabel(r.mode, r.modes)} to {modeLabel(pending, r.modes)}
              ?
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5" data-testid="pn-confirm-mode-lines">
              {change.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="mt-1">{change.after} It applies to the next notification.</p>
          </InlineConfirm>
        )}
      </div>
    </Panel>
  );
}

// ── the selected list ─────────────────────────────────────────────────────────

function EmployeeRow({
  e,
  locked,
  onToggle,
}: {
  e: RecipientEmployee;
  locked: string | null;
  onToggle: (on: boolean) => void;
}) {
  const id = `pn-recipient-check-${e.id}`;
  const where = [e.department, e.branch].filter(Boolean).join(" · ");
  return (
    <li
      className={cn("flex items-start gap-3 px-1 py-2.5", e.selected && "bg-indigo-50 dark:bg-indigo-950")}
      data-testid={`pn-recipient-${e.id}`}
      data-selected={e.selected ? "true" : "false"}
    >
      <Checkbox
        id={id}
        checked={e.selected}
        disabled={locked !== null}
        title={locked ?? undefined}
        onCheckedChange={(v) => onToggle(v === true)}
        aria-label={`${e.name} (${e.code}) on the selected list`}
        data-testid={id}
        className="mt-0.5 h-5 w-5 border-indigo-600 data-[state=checked]:bg-indigo-600 data-[state=checked]:text-white"
      />
      <label htmlFor={id} className={cn("min-w-0 flex-1", locked === null && "cursor-pointer")}>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
          <span className="break-words">{e.name}</span>
          <span className="font-mono text-[11px] font-normal text-muted-foreground">{e.code}</span>
          <StatusBadge tone={e.employmentType === "production" ? "caution" : "info"}>
            {e.employmentType === "production" ? "Production" : "Staff"}
          </StatusBadge>
          {!e.hasPhone && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400"
              title="No phone registered yet: they get nothing on a phone until they sign in on the mobile app"
              data-testid={`pn-recipient-nophone-${e.id}`}
            >
              <Smartphone size={11} /> No phone
            </span>
          )}
        </span>
        <span className="mt-0.5 block break-words text-xs text-muted-foreground">{where || "No department"}</span>
      </label>
    </li>
  );
}

/** A bulk change waiting for its yes: what it was asked about, so a filter changed meanwhile cannot change what it does. */
type BulkAsk = { kind: BulkKind; filters: PickerFilters; shown: number };

function PickerPanel({ r, locked }: { r: PushRecipients; locked: string | null }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const [ask, setAsk] = useState<BulkAsk | null>(null);
  const change = useChangeRecipients();

  const type = asPickerType(url.type);
  const branchScoped = !!user?.branchId;
  const branches = useListBranches({ enabled: !branchScoped, queryKey: getListBranchesQueryKey() });
  const branchList = (branches.data ?? []).filter((b) => b.isActive !== false);
  const showBranches = !branchScoped && branchList.length > 1;
  const branch = showBranches ? asId(url.branch) : "";

  const departments = useOrgDepartments();
  const deptOptions = departmentOptions(departments.all, {
    category: categoryForEmploymentType(type),
    branchId: branch ? Number(branch) : null,
  });
  const showDepartments = departments.isSuccess && deptOptions.length > 0;
  // a department of the other kind (or another branch) stops applying when the type or branch changes
  const department = showDepartments ? keepIfOffered(asId(url.dept), deptOptions, "") : "";

  const filters: PickerFilters = { search: url.q, type, branch, department, show: asPickerShow(url.list) };
  const page = asPage(url.page);

  const filter = (patch: Partial<PickerUrl>) => {
    setAsk(null);
    setUrl({ ...patch, page: "1" });
  };
  const [text, setText] = useDraft(url.q, (next) => filter({ q: next }));

  const list = useRecipientEmployees(recipientParams(filters, page));
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / RECIPIENT_PAGE_SIZE));
  // the count on a bulk button is the count of the filter on screen, never the last one's while the new one loads
  const settled = !!list.data && !list.isPlaceholderData;
  const busy = change.isPending;
  const live = r.mode === "selected";

  const toggle = (e: RecipientEmployee, on: boolean) =>
    change.mutate(on ? { add: [e.id] } : { remove: [e.id] }, {
      onError: (err) =>
        toast({
          title: on ? `Could not add ${e.name}` : `Could not take ${e.name} off the list`,
          description: errorText(err, "Try again."),
          variant: "destructive",
        }),
    });

  const doBulk = (a: BulkAsk) =>
    change.mutate(bulkChange(a.kind, a.filters), {
      onSuccess: (d) => {
        setAsk(null);
        toast({ title: changeDoneText(a.kind, d.changed) });
      },
      onError: (err) =>
        toast({
          title: "Could not change the list",
          description: errorText(err, "Try again."),
          variant: "destructive",
        }),
    });

  const askFor = (kind: BulkKind) => setAsk({ kind, filters, shown: total });

  return (
    <div id={PICKER_ID} className="scroll-mt-4">
      <Panel
        title="Selected employees"
        icon={ListChecks}
        testId="pn-recipient-picker"
        description={
          live ? (
            <>
              The list the <b>Selected employees</b> choice uses, and it is in use now: only the employees ticked here
              get phone notifications. A tick or untick applies at once.
            </>
          ) : (
            <>
              The list the <b>Selected employees</b> choice uses. It has no effect while the choice above is{" "}
              <b>{modeLabel(r.mode, r.modes)}</b>; you can prepare it now and choose Selected employees when it is
              ready.
            </>
          )
        }
        actions={
          <span className="text-xs text-muted-foreground" data-testid="pn-recipient-count">
            On the list: <b className="text-foreground">{employeesText(r.selected)}</b>,{" "}
            {formatNumber(r.selectedWithPhone)} with a phone
          </span>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="pn-recipient-filters">
            <div className="relative w-full sm:w-64">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={PICKER_SEARCH_ID}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Name, code or phone number"
                aria-label="Search employees"
                data-testid="pn-recipient-search"
                className="h-8 w-full pl-8 text-xs"
              />
            </div>
            {showBranches && (
              <select
                aria-label="Branch"
                value={branch}
                onChange={(e) => filter({ branch: e.target.value })}
                className={SELECT}
                data-testid="pn-recipient-branch"
              >
                <option value="">Every branch</option>
                {branchList.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            {showDepartments && (
              <select
                aria-label="Department"
                value={department}
                onChange={(e) => filter({ dept: e.target.value })}
                className={cn(SELECT, "sm:max-w-[16rem]")}
                data-testid="pn-recipient-department"
              >
                <option value="">Every department</option>
                <OrgNativeOptions options={deptOptions} />
              </select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <FilterChips
              label="Employee type"
              testId="pn-recipient-type"
              value={type}
              onChange={(v) => filter({ type: v })}
              items={[
                { value: "", label: "All" },
                { value: "staff", label: "Staff" },
                { value: "production", label: "Production" },
              ]}
            />
            <FilterChips
              label="On the list or not"
              testId="pn-recipient-show"
              value={filters.show}
              onChange={(v) => filter({ list: v })}
              items={[
                { value: "all", label: "Everyone" },
                { value: "on", label: "Selected only", count: formatNumber(r.selected) },
                { value: "off", label: "Not selected" },
              ]}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="pn-bulk">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              disabled={locked !== null || busy || !settled || total === 0 || filters.show === "on"}
              title={locked ?? "Put every employee this filter shows on the list (all pages)"}
              onClick={() => askFor("add")}
              data-testid="pn-bulk-add"
            >
              <UserPlus size={13} /> Add all {formatNumber(settled ? total : 0)} shown
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              disabled={
                locked !== null || busy || !settled || total === 0 || filters.show === "off" || r.selected === 0
              }
              title={locked ?? "Take every employee this filter shows off the list (all pages)"}
              onClick={() => askFor("remove")}
              data-testid="pn-bulk-remove"
            >
              <UserMinus size={13} /> Remove all {formatNumber(settled ? total : 0)} shown
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1 text-xs text-red-700 dark:text-red-400"
              disabled={locked !== null || busy || r.selected === 0}
              title={locked ?? "Take everyone off the list"}
              onClick={() => askFor("clear")}
              data-testid="pn-bulk-clear"
            >
              <Eraser size={13} /> Clear the list
            </Button>
          </div>

          {ask && (
            <InlineConfirm
              testId="pn-confirm-bulk"
              stacked
              confirmLabel={ask.kind === "add" ? "Add them" : ask.kind === "remove" ? "Remove them" : "Clear the list"}
              destructive={ask.kind !== "add"}
              pending={busy}
              onConfirm={() => doBulk(ask)}
              onCancel={() => setAsk(null)}
            >
              {bulkQuestion(ask.kind, ask.filters, { shown: ask.shown, listed: r.selected }, r.mode)}
            </InlineConfirm>
          )}

          {list.isError && !list.data ? (
            <LoadError what="The employees" onRetry={() => void list.refetch()} testId="pn-recipients-error" />
          ) : list.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : rows.length === 0 ? (
            <p
              className="rounded-xl border bg-muted py-8 text-center text-sm text-muted-foreground"
              data-testid="pn-recipients-empty"
            >
              {filters.show === "on" && r.selected === 0
                ? "Nobody is on the list yet. Choose Everyone or Not selected and tick employees to add them."
                : "No employee matches."}
            </p>
          ) : (
            <ul
              className={cn("divide-y rounded-xl border", list.isPlaceholderData && "opacity-60")}
              data-testid="pn-recipient-list"
            >
              {rows.map((e) => (
                <EmployeeRow key={e.id} e={e} locked={locked} onToggle={(on) => toggle(e, on)} />
              ))}
            </ul>
          )}

          <DataPagination
            page={Math.min(page, totalPages)}
            totalPages={totalPages}
            onPageChange={(p) => setUrl({ page: String(p) })}
            totalItems={list.data?.total}
          />
        </div>
      </Panel>
    </div>
  );
}

// ── the phone attendance alerts' timing ───────────────────────────────────────

/**
 * Attendance alert timing (phone): the three timings of Phone Notify Control's own attendance alerts, each with its range.
 * Typed values are checked here as the server checks them; Save sends only the ones that changed and shows a refusal in
 * the section. Locked with the rest of the tab for a View-only login.
 */
function AlertTimingPanel({ locked }: { locked: string | null }) {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = usePhoneAlertSettings();
  const save = useSavePhoneAlertSettings();
  const [draft, setDraft] = useState<AlertTimingDraft | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const readOnly = locked !== null;

  if (isLoading) return <Skeleton className="h-44 rounded-2xl" />;
  if (isError || !data) {
    return <LoadError what="The alert timing" onRetry={() => void refetch()} testId="pn-alert-timing-error" />;
  }

  const shown = draft ?? alertTimingDraft(data);
  const problems = Object.fromEntries(
    ALERT_TIMING_KEYS.map((k) => [k, alertTimingProblem(shown[k], data.limits[k])]),
  ) as Record<AlertTimingKey, string | null>;
  const invalid = ALERT_TIMING_KEYS.some((k) => problems[k] !== null);
  const changes = alertTimingChanges(data, shown);
  const changed = Object.keys(changes).length > 0;

  const change = (k: AlertTimingKey, value: string) => {
    setServerError(null);
    setDraft({ ...shown, [k]: value });
  };
  const doSave = () =>
    save.mutate(changes, {
      onSuccess: () => {
        setDraft(null);
        setServerError(null);
        toast({
          title: "Attendance alert timing saved",
          description: "The phone alerts use it from their next check.",
        });
      },
      onError: (e) => setServerError(errorText(e, "Try again.")),
    });

  return (
    <Panel
      title="Attendance alert timing (phone)"
      icon={Clock}
      testId="pn-alert-timing"
      description="These apply to the phone attendance alerts only."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {ALERT_TIMING_KEYS.map((k) => {
          const limit = data.limits[k];
          const problem = problems[k];
          const id = `pn-alert-${k}`;
          return (
            <div key={k} className="min-w-0 space-y-1" data-testid={`pn-alert-field-${k}`}>
              <label htmlFor={id} className="block text-xs font-semibold leading-snug">
                {limit.label}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={limit.min}
                  max={limit.max}
                  step={1}
                  value={shown[k]}
                  onChange={(e) => change(k, e.target.value)}
                  disabled={readOnly}
                  aria-invalid={problem !== null}
                  aria-describedby={`${id}-hint`}
                  className={cn("h-9 w-24 text-sm tabular-nums", problem && "border-red-500")}
                  data-testid={id}
                />
                <span className="text-xs text-muted-foreground">minutes</span>
              </div>
              <p
                id={`${id}-hint`}
                className={cn(
                  "text-[11px]",
                  problem ? "font-semibold text-red-700 dark:text-red-400" : "text-muted-foreground",
                )}
                data-testid={`${id}-hint`}
              >
                {problem ?? alertTimingRange(limit)}
              </p>
            </div>
          );
        })}
      </div>

      {serverError && (
        <Notice tone="bad" role="alert" testId="pn-alert-timing-server-error" className="mt-3">
          {serverError}
        </Notice>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <span className="text-[11px] text-muted-foreground" data-testid="pn-alert-timing-updated">
          {data.updatedBy ? `Last changed by ${data.updatedBy} on ${formatWhen(data.updatedAt)}` : ""}
        </span>
        <div className="ml-auto flex gap-2">
          {draft && (changed || invalid) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setServerError(null);
              }}
              data-view-safe
              data-testid="pn-alert-timing-undo"
            >
              Put back the saved timing
            </Button>
          )}
          <Button
            size="sm"
            onClick={doSave}
            disabled={readOnly || save.isPending || !changed || invalid}
            title={locked ?? (invalid ? "Fix the timing first" : changed ? undefined : "Nothing has changed yet")}
            data-testid="pn-alert-timing-save"
          >
            {save.isPending ? "Saving…" : "Save the timing"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Settings: who receives phone notifications at all. Every active employee, staff only, production only, or the employees
 * on the selected list (the picker below, which is kept whatever the choice). A change of choice says what it does and asks
 * in the page first; the server refuses Selected employees while the list is empty, so the page says that before asking.
 * Ticking an employee adds them to the list at once; the bulk changes ask first, with their count. Between the two, the
 * timing of the phone attendance alerts (Phone Notify Control's own; no other module reads it).
 */
export default function SettingsTab() {
  const locked = useLockedWhy();
  const { data, isLoading, isError, refetch } = useRecipients();

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="pn-settings-loading">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError what="The settings" onRetry={() => void refetch()} testId="pn-settings-error" />;
  }

  return (
    <div className="space-y-4" data-testid="pn-settings">
      {locked && (
        <Notice tone="neutral" testId="pn-settings-locked">
          {locked}
        </Notice>
      )}
      <ModePanel r={data} locked={locked} />
      <AlertTimingPanel locked={locked} />
      <PickerPanel r={data} locked={locked} />
    </div>
  );
}
