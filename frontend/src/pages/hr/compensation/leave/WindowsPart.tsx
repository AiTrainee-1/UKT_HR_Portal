import { useMemo, useState } from "react";
import { CalendarClock, CalendarPlus, Clock, DoorOpen, Loader2, LogIn, Trash2, Users } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments } from "@/lib/api-client";
import { departmentOptions } from "@/lib/departments";
import { OrgSelectItems } from "@/lib/org-select";
import {
  getListBranchesQueryKey,
  useCompensationWindows,
  useCreateCompensationWindow,
  useDeleteCompensationWindow,
  useListBranches,
  type CompensationWindow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  ClearFilters,
  DataTable,
  FilterBar,
  SearchFilter,
  SelectFilter,
  StatRow,
  StatTile,
  StatusChip as KitChip,
  type DataColumn,
} from "@/pages/hr/outpass-visitors/kit";
import { dateLong, errorMessage, todayIst } from "../logic";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { LEAVE_NESTED, subPath } from "../routes";
import { keepOpenNested, useCanOpen } from "../visible";
import { ErrorNotice, Field, Notice, SwitchOffNotice, useSingleFlight } from "../ui";
import { WINDOW_KIND_OPTIONS, WINDOW_STATUS_OPTIONS, deleteTitle, windowWhen, type WindowWhen } from "./claims-logic";
import { MonthFilter, OrgFilters } from "./LeaveFilters";
import { idOf, monthChoice, monthChoiceLabel, pageOf, useLeaveUrl } from "./leave-url";
import {
  WINDOW_REASON_MAX,
  checkWindow,
  emptyWindowForm,
  windowDateRange,
  windowKindText,
  windowPayload,
  windowScopeText,
  windowSentence,
  windowTimeText,
  type WindowForm,
} from "./leave-logic";

const ANY = "__any__";
const PAGE_SIZE = 25;

const WHEN_CHIP: Record<WindowWhen, { label: string; tone: "amber" | "indigo" | "slate" }> = {
  today: { label: "Today", tone: "amber" },
  upcoming: { label: "Upcoming", tone: "indigo" },
  past: { label: "Past", tone: "slate" },
};

const KIND_INFO = {
  late_in: {
    title: "Late-in",
    text: "Staff may arrive up to the time you set.",
    timeLabel: "Latest arrival time",
    icon: LogIn,
  },
  early_out: {
    title: "Early-out",
    text: "Staff may leave from the time you set.",
    timeLabel: "Earliest leaving time",
    icon: DoorOpen,
  },
} as const;

/**
 * Compensation Leave A: HR announces, for a date, that ALL staff may arrive up to a time (Late-in) or leave from a time
 * (Early-out), for example in heavy rain. On that date only, the shift's own start / end and grace do not apply for the
 * announced edge, and Late-in / Early-out detection does not run for it. Two nested subtabs: Announce, and the list of
 * Announcements (with their count): one month at a time (the current one first), filtered by kind, department, branch,
 * today-and-upcoming or past, and the reason / who announced it, a page at a time from the server. Any announcement can be
 * deleted (an older Compensation Day too): for today or a past day the server checks that day's attendance again. Delete is
 * greyed out, with the server's reason, on a row the server says cannot be removed (`canDelete`: a locked or Payroll Done
 * month, another branch's announcement). The form and the list share one query, so switching between them is instant.
 */
export function WindowsPart({
  featuresOff,
  isBranchScoped,
  nested,
}: {
  featuresOff: boolean;
  isBranchScoped: boolean;
  /** The nested subtab: `announce` (the form and what it does) or `list` (the announcements made). */
  nested: string;
}) {
  const { toast } = useToast();
  const canOpen = useCanOpen();
  const today = useMemo(() => todayIst(), []);
  const [lu, setLu] = useLeaveUrl();
  const month = monthChoice(lu.wmonth, lu.wyear, today, false);
  const query = useCompensationWindows({
    kind: lu.wkind || "all",
    month: month.month ?? undefined,
    year: month.year ?? undefined,
    departmentId: idOf(lu.wdept),
    branchId: idOf(lu.wbranch),
    q: lu.wq.trim() || undefined,
    status: lu.wstatus || undefined,
    page: pageOf(lu.wpage),
    pageSize: PAGE_SIZE,
  });
  const create = useCreateCompensationWindow();
  const remove = useDeleteCompensationWindow();
  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });

  const [form, setForm] = useState<WindowForm>(() => emptyWindowForm(today));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CompensationWindow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const enabled = query.data?.enabled;
  const serverToday = query.data?.today ?? today;
  const master = enabled?.master ?? !featuresOff;
  const canAnnounce = !featuresOff && (enabled?.canAnnounce ?? false);
  const pausedReason =
    featuresOff || enabled?.master === false
      ? "Paused: the OT / Compensation features are switched off in Settings → Payroll"
      : "Paused: company-announced late-in / early-out is switched off in Settings → Compensation";

  const dateRange = useMemo(() => windowDateRange(serverToday), [serverToday]);
  const check = checkWindow(form, serverToday);
  const branchName = branches?.find((b) => String(b.id) === form.branchId)?.name ?? null;
  // A window only ever covers staff (production employees never are), so only Staff departments are offered.
  const deptOptions = useMemo(() => departmentOptions(departments, { category: "staff" }), [departments]);
  const departmentName = deptOptions.find((o) => o.value === form.departmentId)?.label ?? null;
  const sentence = windowSentence(form, {
    branch: isBranchScoped ? null : branchName,
    department: departmentName,
  });
  const rows = useMemo(() => query.data?.results ?? [], [query.data]);
  const total = query.data?.count ?? rows.length;
  // the month's figures: the server's when it sends them, else the rows on screen
  const summary = query.data?.summary ?? null;
  const tiles = {
    total: summary?.total ?? total,
    lateIn: summary?.lateIn ?? rows.filter((r) => r.kind === "late_in").length,
    earlyOut: summary?.earlyOut ?? rows.filter((r) => r.kind === "early_out").length,
    upcoming: summary?.upcoming ?? rows.filter((r) => r.date >= serverToday).length,
  };
  const filtersOn = [lu.wkind, lu.wdept, lu.wbranch, lu.wq, lu.wstatus].filter((v) => v !== "").length;
  /** One filter changes and the list goes back to its first page (one write, see leave-url.ts). */
  const filter = (patch: Partial<typeof lu>) => setLu({ ...patch, wpage: "" });

  const patch = (change: Partial<WindowForm>) => {
    setForm((f) => ({ ...f, ...change }));
    setError(null);
  };

  const once = useSingleFlight();
  const submit = () =>
    once(async () => {
      setTouched(true);
      if (!check.ok || !canAnnounce || create.isPending) return;
      try {
        const made = await create.mutateAsync(windowPayload(form));
        const updated = made.attendanceUpdated ?? 0;
        toast({
          title: "Announcement added",
          description:
            `${windowKindText(made)} for ${dateLong(made.date)} covers ${made.covers} ${made.covers === 1 ? "staff member" : "staff"}.` +
            (updated > 0
              ? ` That day's attendance was updated for ${updated} ${updated === 1 ? "person" : "people"}.`
              : ""),
        });
        setForm((f) => ({ ...emptyWindowForm(today), date: f.date, kind: f.kind }));
        setTouched(false);
        setError(null);
      } catch (err) {
        const message = errorMessage(err, "The announcement could not be saved. Check the connection and try again.");
        setError(message);
        toast({ title: "Could not add the announcement", description: message, variant: "destructive" });
      }
    });

  const openDelete = (row: CompensationWindow) => {
    setDeleteError(null);
    setDeleting(row);
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(deleting.id);
      toast({
        title: "Announcement deleted",
        description:
          deleting.date <= serverToday
            ? `The attendance of ${dateLong(deleting.date)} is checked again for the staff it covered.`
            : undefined,
      });
      setDeleting(null);
    } catch (err) {
      // the server's own sentence (a locked payroll month, Payroll Done ...) stays in the dialog
      const message = errorMessage(err, "The announcement could not be deleted. Check the connection and try again.");
      setDeleteError(message);
      toast({ title: "Could not delete it", description: message, variant: "destructive" });
    }
  };

  const problems = touched ? check.problems : {};
  const info = KIND_INFO[form.kind];
  return (
    <div className="space-y-4" data-testid="windows-part">
      {master && enabled && !enabled.windows && (
        <SwitchOffNotice
          testId="windows-off"
          title="Company-announced late-in / early-out is switched off."
          setting="windows-enabled"
        >
          Announcing and deleting are paused. Every announcement already made stays readable below.
        </SwitchOffNotice>
      )}

      <NestedTabs
        base={subPath("leave", "announcements")}
        value={nested}
        testId="windows-nested"
        label="Sections of Announce late-in / early-out"
        items={keepOpenNested(canOpen, "leave", "announcements", [
          { value: "announce", label: LEAVE_NESTED.announcements[0].label },
          { value: "list", label: LEAVE_NESTED.announcements[1].label, count: query.data ? total : undefined },
        ])}
      >
        {nested === "announce" && (
          <div className="grid gap-4 lg:grid-cols-5">
            <SectionCard
              testId="windows-form"
              className="lg:col-span-3"
              icon={CalendarPlus}
              title="Announce late-in / early-out"
              description="For all staff on one date, for example heavy rain or a transport strike. Production employees are never covered."
            >
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                noValidate
              >
                <div role="radiogroup" aria-label="What is announced" className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(KIND_INFO) as (keyof typeof KIND_INFO)[]).map((kind) => {
                    const k = KIND_INFO[kind];
                    const Icon = k.icon;
                    const on = form.kind === kind;
                    return (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => patch({ kind })}
                        data-testid={`window-kind-${kind}`}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          on ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50",
                        )}
                      >
                        <span className="mt-0.5 rounded-lg bg-white p-2 text-indigo-700 ring-1 ring-slate-200">
                          <Icon size={16} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-gray-900">
                            {k.title}
                            {on && <span className="ml-2 text-[11px] font-semibold text-indigo-700">Chosen</span>}
                          </span>
                          <span className="block text-xs text-muted-foreground">{k.text}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Date"
                    htmlFor="window-date"
                    problem={problems.date}
                    hint={`Any day of ${dateRange.label}, past or upcoming.`}
                  >
                    <Input
                      id="window-date"
                      type="date"
                      value={form.date}
                      min={dateRange.min}
                      max={dateRange.max}
                      onChange={(e) => patch({ date: e.target.value })}
                      aria-invalid={problems.date ? true : undefined}
                      data-testid="window-date"
                    />
                  </Field>
                  <Field label={info.timeLabel} htmlFor="window-time" problem={problems.time}>
                    <Input
                      id="window-time"
                      type="time"
                      value={form.time}
                      onChange={(e) => patch({ time: e.target.value })}
                      aria-invalid={problems.time ? true : undefined}
                      data-testid="window-time"
                    />
                  </Field>
                </div>

                <Field
                  label="Reason"
                  htmlFor="window-reason"
                  problem={problems.reason}
                  hint={`${form.reason.trim().length} / ${WINDOW_REASON_MAX}. Staff see it with the announcement.`}
                >
                  <Textarea
                    id="window-reason"
                    rows={2}
                    maxLength={WINDOW_REASON_MAX + 50}
                    value={form.reason}
                    onChange={(e) => patch({ reason: e.target.value })}
                    placeholder="e.g. Heavy rain: buses are not running"
                    aria-invalid={problems.reason ? true : undefined}
                    data-testid="window-reason"
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Department (optional)"
                    htmlFor="window-dept"
                    hint="Leave on Any department for every department."
                  >
                    <Select
                      value={form.departmentId || ANY}
                      onValueChange={(v) => patch({ departmentId: v === ANY ? "" : v })}
                    >
                      <SelectTrigger id="window-dept" data-testid="window-dept">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>Any department</SelectItem>
                        <OrgSelectItems options={deptOptions} />
                      </SelectContent>
                    </Select>
                  </Field>
                  {!isBranchScoped && (
                    <Field
                      label="Branch (optional)"
                      htmlFor="window-branch"
                      hint="Leave on Any branch for the whole company."
                    >
                      <Select
                        value={form.branchId || ANY}
                        onValueChange={(v) => patch({ branchId: v === ANY ? "" : v })}
                      >
                        <SelectTrigger id="window-branch" data-testid="window-branch">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ANY}>Any branch</SelectItem>
                          {branches?.map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </div>

                {sentence && (
                  <Notice accent="slate" testId="window-summary">
                    <p>{sentence}</p>
                  </Notice>
                )}
                {error && <ErrorNotice testId="window-error">{error}</ErrorNotice>}

                <Button
                  type="submit"
                  disabled={!canAnnounce || create.isPending}
                  title={canAnnounce ? undefined : pausedReason}
                  data-testid="window-submit"
                >
                  {create.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
                  Add announcement
                </Button>
              </form>
            </SectionCard>

            <SectionCard
              testId="windows-explain"
              className="lg:col-span-2"
              icon={Clock}
              title="What an announcement does"
              description="On the announced date only."
            >
              <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-gray-600">
                <li>
                  <strong>Late-in:</strong> everyone covered may arrive up to the time. The shift&apos;s start and its
                  grace do not apply, so arriving by the time is not Late. After it, the usual Late rules count from
                  that time.
                </li>
                <li>
                  <strong>Early-out:</strong> everyone covered may leave from the time. The shift&apos;s end and its
                  grace do not apply, so leaving at or after the time is not an Early Out.
                </li>
                <li>
                  Attendance marks the days of the staff who used it as Compensation, and History lists who used it.
                </li>
                <li>
                  Any day of the current month can be announced, past days included: a past day&apos;s attendance is
                  judged again straight away (a day HR edited by hand stays as it is). Once the next month begins, the
                  previous month is closed.
                </li>
                <li>
                  One late-in and one early-out per person per date. Any announcement can be deleted: for today or a
                  past day that day&apos;s attendance is checked again, and a payroll month that is locked or marked
                  Payroll Done refuses it.
                </li>
                <li>It is a company announcement, not a leave: a day nobody attended is still absent.</li>
              </ul>
            </SectionCard>
          </div>
        )}

        {nested === "list" && (
          <SectionCard
            testId="windows-list"
            icon={Users}
            title="Announcements"
            description={`Who announced each one and how many staff it covers, ${monthChoiceLabel(month)}. Any of them can be deleted, older Compensation Days too, unless its payroll month is done or it belongs to another branch: Delete then says why.`}
            bodyClassName="space-y-3"
          >
            <FilterBar label="Announcement filters" testId="windows-filters" sticky={false}>
              <MonthFilter
                value={month}
                today={serverToday}
                onChange={(m, y) => filter({ wmonth: m, wyear: y })}
                label="Month of the announcements"
                testId="windows-month"
              />
              <SelectFilter
                label="Kind"
                value={lu.wkind}
                onChange={(v) => filter({ wkind: v })}
                options={WINDOW_KIND_OPTIONS}
                allLabel="Every kind"
                testId="windows-kind"
              />
              <SelectFilter
                label="When"
                value={lu.wstatus}
                onChange={(v) => filter({ wstatus: v })}
                options={WINDOW_STATUS_OPTIONS}
                allLabel="Upcoming and past"
                testId="windows-status"
              />
              <OrgFilters
                dept={lu.wdept}
                branch={lu.wbranch}
                onDept={(v) => filter({ wdept: v })}
                onBranch={(v) => filter({ wbranch: v })}
                testId="windows"
              />
              <SearchFilter
                value={lu.wq}
                onChange={(v) => filter({ wq: v })}
                placeholder="Reason or who announced"
                label="Search by reason or who announced"
                testId="windows-search"
              />
              <ClearFilters
                count={filtersOn}
                onClear={() => filter({ wkind: "", wdept: "", wbranch: "", wq: "", wstatus: "" })}
                testId="windows-clear"
              />
            </FilterBar>

            <StatRow columns={4} testId="windows-kpis">
              <StatTile
                label="Announcements"
                value={tiles.total}
                hint={monthChoiceLabel(month)}
                icon={CalendarPlus}
                loading={query.isLoading}
                testId="windows-kpi-total"
              />
              <StatTile
                label="Late-in"
                value={tiles.lateIn}
                icon={LogIn}
                tone="indigo"
                loading={query.isLoading}
                onClick={() => filter({ wkind: lu.wkind === "late_in" ? "" : "late_in" })}
                active={lu.wkind === "late_in"}
                title="Show only the late-in announcements"
                testId="windows-kpi-late"
              />
              <StatTile
                label="Early-out"
                value={tiles.earlyOut}
                icon={DoorOpen}
                tone="amber"
                loading={query.isLoading}
                onClick={() => filter({ wkind: lu.wkind === "early_out" ? "" : "early_out" })}
                active={lu.wkind === "early_out"}
                title="Show only the early-out announcements"
                testId="windows-kpi-early"
              />
              <StatTile
                label="Today and upcoming"
                value={tiles.upcoming}
                icon={CalendarClock}
                tone="teal"
                loading={query.isLoading}
                onClick={() => filter({ wstatus: lu.wstatus === "upcoming" ? "" : "upcoming" })}
                active={lu.wstatus === "upcoming"}
                title="Show only today and the days to come"
                testId="windows-kpi-upcoming"
              />
            </StatRow>

            <DataTable
              columns={windowColumns({
                today: serverToday,
                onDelete: openDelete,
                paused: !canAnnounce,
                pausedReason,
              })}
              rows={rows}
              rowKey={(r) => r.id}
              loading={query.isLoading}
              error={
                query.isError && !query.data
                  ? `Could not load the announcements. ${errorMessage(query.error, "Check the connection and try again.")}`
                  : null
              }
              onRetry={() => void query.refetch()}
              empty={{
                icon: CalendarPlus,
                title:
                  filtersOn > 0
                    ? "No announcement matches these filters"
                    : `No announcement in ${monthChoiceLabel(month)}`,
                hint:
                  filtersOn > 0
                    ? "Clear a filter, or pick another month."
                    : "Pick another month, or announce a late-in or early-out in the Announce tab when something unusual happens.",
              }}
              pagination={{
                page: pageOf(lu.wpage),
                pageSize: PAGE_SIZE,
                total,
                onPageChange: (p) => setLu({ wpage: p > 1 ? String(p) : "" }),
              }}
              caption="Announcements"
              testId="windows-table"
            />
          </SectionCard>
        )}
      </NestedTabs>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}>
        <AlertDialogContent data-testid="window-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this announcement?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${windowKindText(deleting)} on ${dateLong(deleting.date)}, covering ${deleting.covers} ${deleting.covers === 1 ? "staff member" : "staff"}: staff will be judged by their normal shifts again on that day.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting && (
            <ul
              className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-600"
              data-testid="window-delete-effects"
            >
              <li>
                {deleting.date <= serverToday
                  ? "That day's attendance is checked again for every staff member it covered (a day HR edited by hand stays as it is)."
                  : "The day has not come yet: its attendance will simply follow the normal shift."}
              </li>
              <li>The staff it covered are told it was cancelled.</li>
              <li>
                If that day&apos;s payroll month is locked or marked Payroll Done, the delete is refused and the reason
                is shown here.
              </li>
            </ul>
          )}
          {deleteError && <ErrorNotice testId="window-delete-error">{deleteError}</ErrorNotice>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={remove.isPending}
              data-testid="window-delete-confirm"
            >
              Delete announcement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The columns of the announcements table: the date (with Today / Upcoming / Past), what, why, who it covers, who
 *  announced it, and Delete (every kind, an older Compensation Day too: greyed out with the reason where the server says
 *  it cannot be removed). */
function windowColumns({
  today,
  onDelete,
  paused,
  pausedReason,
}: {
  today: string;
  onDelete: (row: CompensationWindow) => void;
  paused: boolean;
  pausedReason: string;
}): DataColumn<CompensationWindow>[] {
  return [
    {
      key: "date",
      header: "Date",
      cell: (row) => {
        const when = WHEN_CHIP[windowWhen(row.date, today)];
        return (
          <div className="flex flex-col items-start gap-0.5" data-testid={`window-row-${row.id}`}>
            <span className="font-semibold text-slate-900">{dateLong(row.date)}</span>
            <KitChip tone={when.tone}>{when.label}</KitChip>
          </div>
        );
      },
      truncate: false,
      minWidth: 140,
    },
    {
      key: "what",
      header: "What",
      cell: (row) => (
        <div className="flex flex-col items-start gap-0.5">
          <KitChip tone={row.kind === "day" ? "slate" : row.kind === "late_in" ? "indigo" : "amber"}>
            {windowKindText(row)}
          </KitChip>
          <span className="text-xs text-slate-600">{windowTimeText(row)}</span>
        </div>
      ),
      truncate: false,
      minWidth: 170,
    },
    {
      key: "reason",
      header: "Reason",
      cell: (row) => row.reason || "—",
      text: (row) => row.reason,
      maxWidth: 260,
    },
    {
      key: "covers",
      header: "Covers",
      cell: (row) => (
        <div className="leading-tight">
          <p className="font-semibold text-slate-900">
            {row.covers} {row.covers === 1 ? "staff member" : "staff"}
          </p>
          <p className="text-[11px] text-slate-500">{windowScopeText(row)}</p>
        </div>
      ),
      text: (row) => windowScopeText(row),
      minWidth: 140,
    },
    {
      key: "by",
      header: "Announced by",
      cell: (row) => row.announcedBy ?? "HR",
      hideOnPhone: true,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      truncate: false,
      cell: (row) => (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-11 text-rose-600 sm:size-9"
          disabled={paused || !row.canDelete}
          aria-label={`Delete the announcement of ${dateLong(row.date)}`}
          title={deleteTitle(row, paused, pausedReason)}
          onClick={() => onDelete(row)}
          data-testid={`window-delete-${row.id}`}
        >
          <Trash2 size={15} />
        </Button>
      ),
    },
  ];
}
