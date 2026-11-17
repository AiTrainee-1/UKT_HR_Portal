import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, History, Loader2, Pencil, Play, Plus, Search, Trash2, Workflow } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  useAttendanceNotifyAutomations,
  type NotifyAutomation,
  type NotifyChannel,
  type NotifyEmployeeType,
} from "@/lib/api-client/custom-hooks";
import { useNotifyActions } from "./actions";
import {
  CHANNEL_LABEL,
  errorText,
  frequencyText,
  nextRunText,
  orderedCategories,
  reportText,
  sortAutomations,
  timesText,
  whenText,
} from "./logic";
import { CategoryChip, ChannelBadge, EMPLOYEE_TYPE_OPTIONS, EmployeeTypeChip, RunStatusChip, Segmented } from "./parts";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const HEADERS = [
  "Automation",
  "Channel",
  "Report",
  "Employees",
  "Categories",
  "Recipients",
  "Times",
  "Frequency",
  "Next run",
  "Last run",
  "Active",
  "",
];

function Row({ a }: { a: NotifyAutomation }) {
  const actions = useNotifyActions();
  const last = a.lastRun;
  const hasErrors = !!last && (last.status === "failed" || last.status === "partial");
  return (
    <TableRow data-testid={`an-row-${a.id}`} data-active={a.isActive ? "true" : "false"}>
      <TableCell className="min-w-[12rem]">
        <span className="block font-semibold text-slate-900">{a.name}</span>
        <span className="block text-[11px] text-slate-500">
          {a.createdBy ? `By ${a.createdBy}` : ""}
          {a.branch ? `${a.createdBy ? " · " : ""}${a.branch.name} only` : ""}
        </span>
      </TableCell>
      <TableCell>
        <ChannelBadge channel={a.channel} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-slate-700">{reportText(a)}</TableCell>
      <TableCell>
        <EmployeeTypeChip type={a.employeeType} />
      </TableCell>
      <TableCell className="min-w-[10rem]">
        <span className="flex flex-wrap gap-1">
          {orderedCategories(a.categories).map((c) => (
            <CategoryChip key={c} category={c} />
          ))}
        </span>
      </TableCell>
      <TableCell className="min-w-[9rem] text-xs text-slate-700">{a.recipientSummary || "—"}</TableCell>
      <TableCell className="text-xs text-slate-700">{timesText(a.times)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs text-slate-700">{frequencyText(a)}</TableCell>
      <TableCell className="min-w-[8rem] text-xs text-slate-700" data-testid={`an-row-next-${a.id}`}>
        {nextRunText(a)}
      </TableCell>
      <TableCell className="min-w-[8rem]">
        {last ? (
          <span className="flex flex-col items-start gap-1">
            <span className="text-xs text-slate-600">{whenText(last.at)}</span>
            <RunStatusChip status={last.status} title={last.error || undefined} />
          </span>
        ) : (
          <span className="text-xs text-slate-400">Never</span>
        )}
      </TableCell>
      <TableCell>
        {actions.togglingId === a.id ? (
          <Loader2 size={16} className="animate-spin text-slate-400" />
        ) : (
          <Switch
            checked={a.isActive}
            onCheckedChange={(on) => actions.toggle(a, on)}
            aria-label={`${a.isActive ? "Disable" : "Enable"} ${a.name}`}
            data-testid={`an-row-toggle-${a.id}`}
          />
        )}
      </TableCell>
      <TableCell>
        <span className="flex items-center justify-end gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-emerald-700"
            onClick={() => actions.askRun(a)}
            disabled={actions.startingId === a.id}
            aria-label={`Run now: ${a.name}`}
            title="Run now"
            data-testid={`an-row-run-${a.id}`}
          >
            <Play size={14} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => actions.edit(a)}
            aria-label={`Edit ${a.name}`}
            title="Edit"
            data-testid={`an-row-edit-${a.id}`}
          >
            <Pencil size={14} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => actions.showHistory({ automation: a.id })}
            aria-label={`View the history of ${a.name}`}
            title="View history"
            data-view-safe
            data-testid={`an-row-history-${a.id}`}
          >
            <History size={14} />
          </Button>
          {hasErrors && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-red-600"
              onClick={() => actions.showHistory({ automation: a.id, run: last.id })}
              aria-label={`View the errors of ${a.name}`}
              title={last.error || "View errors"}
              data-view-safe
              data-testid={`an-row-errors-${a.id}`}
            >
              <AlertTriangle size={14} />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-slate-400 hover:text-red-600"
            onClick={() => actions.askDelete(a)}
            aria-label={`Delete ${a.name}`}
            title="Delete"
            data-testid={`an-row-delete-${a.id}`}
          >
            <Trash2 size={14} />
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

/** Every automation of every channel in one table, with filters, the on / off switch and every action. */
export default function AutomationsTab() {
  const actions = useNotifyActions();
  const [channel, setChannel] = useState<NotifyChannel | "all">("all");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [kind, setKind] = useState<NotifyEmployeeType | "any">("any");
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const q = useAttendanceNotifyAutomations({
    channel: channel === "all" ? null : channel,
    status: status === "all" ? null : status,
    search,
  });
  // Staff / Production is filtered here (the server's list has no such filter); "All employees" automations are their own kind
  const items = useMemo(
    () => sortAutomations((q.data ?? []).filter((a) => kind === "any" || a.employeeType === kind)),
    [q.data, kind],
  );
  const filtered = channel !== "all" || status !== "all" || kind !== "any" || search !== "";

  return (
    <SectionCard
      icon={Workflow}
      title={`All automations${q.data ? ` (${items.length})` : ""}`}
      description="Every automation of every channel: switch one on or off, run it now, edit it, see its history or delete it."
      testId="an-automations"
      actions={
        <Button onClick={() => actions.create(null)} className="gap-1.5" data-testid="an-new-any">
          <Plus size={14} /> New automation
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="an-automations-filters">
        <div className="relative min-w-[14rem] flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name"
            className="pl-8"
            aria-label="Search automations"
            data-testid="an-automations-search"
          />
        </div>
        <Segmented
          options={[
            { value: "all", label: "Every channel" },
            { value: "whatsapp", label: CHANNEL_LABEL.whatsapp },
            { value: "email", label: CHANNEL_LABEL.email },
            { value: "chat", label: CHANNEL_LABEL.chat },
          ]}
          value={channel}
          onChange={setChannel}
          ariaLabel="Channel"
          testId="an-filter-channel"
        />
        <Segmented
          options={[
            { value: "all", label: "Any status" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
          value={status}
          onChange={setStatus}
          ariaLabel="Status"
          testId="an-filter-status"
        />
        <Segmented
          options={[{ value: "any" as const, label: "Any employees" }, ...EMPLOYEE_TYPE_OPTIONS]}
          value={kind}
          onChange={setKind}
          ariaLabel="Employees"
          testId="an-filter-kind"
        />
      </div>

      {q.isError && !q.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          The automations could not be loaded: {errorText(q.error) ?? "the server did not answer"}.
          <Button size="sm" variant="outline" onClick={() => void q.refetch()} data-view-safe>
            Try again
          </Button>
        </div>
      ) : !q.data ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <EmptyNote
          icon={Workflow}
          title={filtered ? "No automation matches these filters" : "No automation yet"}
          hint={
            filtered
              ? "Clear a filter or the search to see more."
              : "Create one here or on a channel's tab to send attendance reports on a schedule."
          }
          testId="an-automations-empty"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-100">
          <Table data-testid="an-automations-table">
            <TableHeader>
              <TableRow>
                {HEADERS.map((h, i) => (
                  <TableHead key={h || i} className="whitespace-nowrap text-xs">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <Row key={a.id} a={a} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}
