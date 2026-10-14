import { useMemo, useState } from "react";
import { CalendarPlus, Clock, DoorOpen, Loader2, LogIn, Trash2, Users } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
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
import {
  getListBranchesQueryKey,
  useCompensationWindows,
  useCreateCompensationWindow,
  useDeleteCompensationWindow,
  useListBranches,
  type CompensationWindow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { addDays, dateLong, errorMessage, todayIst } from "../logic";
import {
  CELL,
  ErrorNotice,
  Field,
  Notice,
  PersonCell,
  StatusChip,
  SwitchOffNotice,
  TABLE_HEAD,
  useSingleFlight,
} from "../ui";
import {
  WINDOW_MAX_DAYS_AHEAD,
  WINDOW_REASON_MAX,
  checkWindow,
  emptyWindowForm,
  splitWindows,
  windowKindText,
  windowPayload,
  windowScopeText,
  windowSentence,
  windowTimeText,
  type WindowForm,
} from "./leave-logic";

const ANY = "__any__";

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
 * announced edge, and Late-in / Early-out detection does not run for it.
 */
export function WindowsPart({ featuresOff, isBranchScoped }: { featuresOff: boolean; isBranchScoped: boolean }) {
  const { toast } = useToast();
  const today = useMemo(() => todayIst(), []);
  const query = useCompensationWindows({ kind: "all" });
  const create = useCreateCompensationWindow();
  const remove = useDeleteCompensationWindow();
  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });

  const [form, setForm] = useState<WindowForm>(() => emptyWindowForm(today));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CompensationWindow | null>(null);

  const enabled = query.data?.enabled;
  const serverToday = query.data?.today ?? today;
  const master = enabled?.master ?? !featuresOff;
  const canAnnounce = !featuresOff && (enabled?.canAnnounce ?? false);
  const pausedReason =
    featuresOff || enabled?.master === false
      ? "Paused: the OT / Compensation features are switched off in Settings → Payroll"
      : "Paused: company-announced late-in / early-out is switched off in Settings → Compensation";

  const check = checkWindow(form, serverToday);
  const branchName = branches?.find((b) => String(b.id) === form.branchId)?.name ?? null;
  const departmentName = departments?.find((d) => String(d.id) === form.departmentId)?.name ?? null;
  const sentence = windowSentence(form, {
    branch: isBranchScoped ? null : branchName,
    department: departmentName,
  });
  const lists = useMemo(() => splitWindows(query.data?.results ?? [], serverToday), [query.data, serverToday]);

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
        toast({
          title: "Announcement added",
          description: `${windowKindText(made)} for ${dateLong(made.date)} covers ${made.covers} ${made.covers === 1 ? "staff member" : "staff"}.`,
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

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast({ title: "Announcement deleted" });
      setDeleting(null);
    } catch (err) {
      toast({
        title: "Could not delete it",
        description: errorMessage(err, "It may already have been acted on: only a future date can be removed."),
        variant: "destructive",
      });
      setDeleting(null);
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
                hint={`Today or later, up to ${WINDOW_MAX_DAYS_AHEAD} days ahead.`}
              >
                <Input
                  id="window-date"
                  type="date"
                  value={form.date}
                  min={serverToday}
                  max={addDays(serverToday, WINDOW_MAX_DAYS_AHEAD)}
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
                    {departments?.map((d) => (
                      <SelectItem key={d.id} value={String(d.id)}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {!isBranchScoped && (
                <Field
                  label="Branch (optional)"
                  htmlFor="window-branch"
                  hint="Leave on Any branch for the whole company."
                >
                  <Select value={form.branchId || ANY} onValueChange={(v) => patch({ branchId: v === ANY ? "" : v })}>
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
              <strong>Late-in:</strong> everyone covered may arrive up to the time. The shift&apos;s start and its grace
              do not apply, so arriving by the time is not Late. After it, the usual Late rules count from that time.
            </li>
            <li>
              <strong>Early-out:</strong> everyone covered may leave from the time. The shift&apos;s end and its grace
              do not apply, so leaving at or after the time is not an Early Out.
            </li>
            <li>
              Attendance marks the days of the staff who used it as Compensation, and History &amp; Reports lists who
              used it.
            </li>
            <li>
              One late-in and one early-out per person per date. A future date can be deleted; today&apos;s has already
              acted.
            </li>
            <li>It is a company announcement, not a leave: a day nobody attended is still absent.</li>
          </ul>
        </SectionCard>
      </div>

      <SectionCard
        testId="windows-list"
        icon={Users}
        title="Announcements"
        description="Who announced each one and how many staff it covers. Only a future date can be deleted."
      >
        {query.isLoading ? (
          <SkeletonRows rows={3} />
        ) : query.isError && !query.data ? (
          <LoadError
            what="the announcements"
            detail={errorDetail(query.error)}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            testId="windows-error"
          />
        ) : (query.data?.results.length ?? 0) === 0 ? (
          <EmptyNote
            icon={CalendarPlus}
            title="No announcement yet"
            hint="Announce a late-in or early-out above when something unusual happens."
            testId="windows-empty"
          />
        ) : (
          <div className="space-y-5">
            <WindowTable
              title="Today and upcoming"
              rows={lists.upcoming}
              onDelete={setDeleting}
              paused={!canAnnounce}
              pausedReason={pausedReason}
              testId="windows-upcoming"
            />
            <WindowTable
              title="Earlier"
              rows={lists.earlier}
              onDelete={setDeleting}
              paused={!canAnnounce}
              pausedReason={pausedReason}
              testId="windows-earlier"
            />
            {query.data?.truncated && (
              <p className="text-xs text-muted-foreground">Only the newest {query.data.results.length} are shown.</p>
            )}
          </div>
        )}
      </SectionCard>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}>
        <AlertDialogContent data-testid="window-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this announcement?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${windowKindText(deleting)} on ${dateLong(deleting.date)}: staff will be judged by their normal shifts again on that day.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
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

function WindowTable({
  title,
  rows,
  onDelete,
  paused,
  pausedReason,
  testId,
}: {
  title: string;
  rows: CompensationWindow[];
  onDelete: (row: CompensationWindow) => void;
  paused: boolean;
  pausedReason: string;
  testId: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2" data-testid={testId}>
      <h4 className="text-sm font-bold text-gray-900">
        {title} <span className="font-semibold text-muted-foreground">({rows.length})</span>
      </h4>
      <div className="overflow-x-auto rounded-xl border border-slate-100">
        <table className="w-full min-w-[760px] text-sm">
          <thead className={TABLE_HEAD}>
            <tr>
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">What</th>
              <th className="px-3 py-2.5">Reason</th>
              <th className="px-3 py-2.5">Covers</th>
              <th className="px-3 py-2.5">Announced by</th>
              <th className="px-3 py-2.5 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.id} data-testid={`window-row-${row.id}`}>
                <td className={`${CELL} whitespace-nowrap font-semibold`}>{dateLong(row.date)}</td>
                <td className={CELL}>
                  <StatusChip tone={row.kind === "day" ? "neutral" : row.kind === "late_in" ? "info" : "accent"}>
                    {windowKindText(row)}
                  </StatusChip>
                  <p className="mt-1 text-xs text-gray-600">{windowTimeText(row)}</p>
                </td>
                <td className={`${CELL} max-w-xs break-words text-gray-700`}>{row.reason || "—"}</td>
                <td className={CELL}>
                  <p className="font-semibold">
                    {row.covers} {row.covers === 1 ? "staff member" : "staff"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{windowScopeText(row)}</p>
                </td>
                <td className={CELL}>
                  <PersonCell name={row.announcedBy ?? "HR"} />
                </td>
                <td className={`${CELL} text-right`}>
                  {row.canDelete && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-rose-600"
                      disabled={paused}
                      aria-label={`Delete the announcement of ${dateLong(row.date)}`}
                      title={paused ? pausedReason : `Delete the announcement of ${dateLong(row.date)}`}
                      onClick={() => onDelete(row)}
                      data-testid={`window-delete-${row.id}`}
                    >
                      <Trash2 size={15} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
