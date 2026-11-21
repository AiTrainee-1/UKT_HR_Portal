import { useState } from "react";
import { AlertTriangle, History, Loader2, Pencil, Phone, Play, Plus, Save, Trash2 } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceNotifyAutomations,
  useUpdateAttendanceNotifySettings,
  type NotifyAutomation,
  type NotifyChannel,
  type NotifyOverview,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { useNotifyActions } from "./actions";
import { ChatAudienceWarning } from "./Recipients";
import {
  CHANNEL_LABEL,
  errorText,
  nextRunText,
  normalisePhone,
  orderedCategories,
  phoneLabel,
  reportText,
  scheduleText,
  sortAutomations,
  whenText,
} from "./logic";
import { CHANNEL_META, CategoryChip, ChannelIcon, EmployeeTypeChip, RunStatusChip } from "./parts";

const INTRO: Record<NotifyChannel, string> = {
  whatsapp: "Reports sent as WhatsApp messages to numbers, groups and saved lists, from the HRMS's linked WhatsApp.",
  email: "Reports emailed from the HRMS's Gmail, as an HTML report or plain text, with the PDF attached if you like.",
  chat: "Reports posted in the Internal Chat: a company channel per branch, or a department's channel.",
};

/** HR's own WhatsApp number (not the business number messages are sent from): set once here, used by "Also send
 *  to the connected number". */
export function ConnectedNumberCard({ number }: { number: string | undefined }) {
  const { toast } = useToast();
  const update = useUpdateAttendanceNotifySettings();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setText(number ?? "");
    setError(null);
    setEditing(true);
  };
  const saveNumber = async () => {
    const value = text.trim() ? normalisePhone(text) : "";
    if (value === null) {
      setError("That is not a WhatsApp number. Use 10 digits (98765 43210) or +country code.");
      return;
    }
    try {
      await update.mutateAsync({ connectedNumber: value });
      setEditing(false);
      toast({
        title: value ? "Connected number saved" : "Connected number cleared",
        description: value ? phoneLabel(value) : "Automations that send to it skip it until one is set.",
      });
    } catch (err) {
      setError(errorText(err) ?? "The number could not be saved.");
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3"
      data-testid="an-connected-number"
    >
      <span className="rounded-xl bg-white p-2 text-emerald-700 ring-1 ring-emerald-100">
        <Phone size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-emerald-900">Connected WhatsApp number</p>
        {!editing ? (
          <p className="text-xs text-emerald-800" data-testid="an-connected-number-value">
            {number ? (
              <>
                <span className="font-mono font-semibold">{phoneLabel(number)}</span> · HR's own WhatsApp number. An
                automation can send its report here too.
              </>
            ) : (
              "Not set yet. Type HR's own WhatsApp number (not the business number messages are sent from), so automations can send their report to it."
            )}
          </p>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void saveNumber()}
              placeholder="98765 43210"
              inputMode="tel"
              autoFocus
              className="h-8 w-48 bg-white"
              aria-label="Connected WhatsApp number"
              data-testid="an-connected-number-input"
            />
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void saveNumber()}
              disabled={update.isPending}
              data-testid="an-connected-number-save"
            >
              {update.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save number
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)} data-view-safe>
              Cancel
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs font-medium text-red-600">
            {error}
          </p>
        )}
      </div>
      {!editing && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 bg-white"
          onClick={start}
          data-testid="an-connected-number-edit"
        >
          <Pencil size={13} /> {number ? "Edit number" : "Set number"}
        </Button>
      )}
    </div>
  );
}

/** One automation as a card: what it reports, when, to whom, the next and the last send, and what can be done to it. */
export function AutomationCard({ a }: { a: NotifyAutomation }) {
  const actions = useNotifyActions();
  const last = a.lastRun;
  const busyToggle = actions.togglingId === a.id;
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm transition-shadow hover:shadow-md",
        a.isActive ? "border-slate-200" : "border-dashed border-slate-300",
      )}
      data-testid={`an-card-${a.id}`}
      data-active={a.isActive ? "true" : "false"}
    >
      <header className="flex items-start gap-3">
        <ChannelIcon channel={a.channel} size={15} className={a.isActive ? "" : "opacity-50"} />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-bold text-slate-900" title={a.name}>
            {a.name}
          </h4>
          <p className="text-xs text-slate-500">{reportText(a)}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[11px] font-semibold text-slate-500">
          {busyToggle ? <Loader2 size={13} className="animate-spin" /> : a.isActive ? "On" : "Off"}
          <Switch
            checked={a.isActive}
            disabled={busyToggle}
            onCheckedChange={(on) => actions.toggle(a, on)}
            aria-label={`${a.isActive ? "Disable" : "Enable"} ${a.name}`}
            data-testid={`an-card-toggle-${a.id}`}
          />
        </label>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <EmployeeTypeChip type={a.employeeType} />
        {orderedCategories(a.categories).map((c) => (
          <CategoryChip key={c} category={c} />
        ))}
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Sends</dt>
          <dd className="font-medium text-slate-800">{scheduleText(a)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">To</dt>
          <dd className="font-medium text-slate-800">{a.recipientSummary || "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Next send</dt>
          <dd className="font-medium text-slate-800" data-testid={`an-card-next-${a.id}`}>
            {nextRunText(a)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Last send</dt>
          <dd className="flex flex-wrap items-center gap-1.5 font-medium text-slate-800">
            {last ? (
              <>
                {whenText(last.at)} <RunStatusChip status={last.status} title={last.error || undefined} />
              </>
            ) : (
              "Never"
            )}
          </dd>
        </div>
      </dl>
      {last?.error && (last.status === "failed" || last.status === "partial") && (
        <p className="flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {last.error}
        </p>
      )}

      <footer className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
        <Button
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => actions.askRun(a)}
          disabled={actions.startingId === a.id}
          data-testid={`an-card-run-${a.id}`}
        >
          <Play size={13} /> Run now
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={() => actions.edit(a)}
          data-testid={`an-card-edit-${a.id}`}
        >
          <Pencil size={13} /> Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-slate-600"
          onClick={() => actions.showHistory({ automation: a.id })}
          data-view-safe
          data-testid={`an-card-history-${a.id}`}
        >
          <History size={13} /> History
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-8 w-8 p-0 text-slate-400 hover:text-red-600"
          onClick={() => actions.askDelete(a)}
          aria-label={`Delete ${a.name}`}
          title="Delete"
          data-testid={`an-card-delete-${a.id}`}
        >
          <Trash2 size={14} />
        </Button>
      </footer>
    </article>
  );
}

/** A channel's tab: its automations as cards and "New automation" (WhatsApp: the connected number; chat: who reads it). */
export default function ChannelTab({
  channel,
  overview,
}: {
  channel: NotifyChannel;
  overview: NotifyOverview | undefined;
}) {
  const actions = useNotifyActions();
  const q = useAttendanceNotifyAutomations({ channel });
  const items = sortAutomations(q.data ?? []);
  const state = overview?.channels[channel];
  const Icon = CHANNEL_META[channel].icon;

  return (
    <div className="space-y-4" data-testid={`an-tab-${channel}`}>
      {channel === "whatsapp" && <ConnectedNumberCard number={overview?.settings.connectedNumber} />}
      {channel === "chat" && <ChatAudienceWarning />}
      {state && !state.available && (
        <p
          className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
          role="status"
          data-testid="an-channel-unavailable"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {CHANNEL_LABEL[channel]} cannot deliver right now{state.note ? `: ${state.note}` : "."} Automations still run
          on time and their sends show as failed in Execution History until it is set up.
        </p>
      )}
      <SectionCard
        icon={Icon}
        title={`${CHANNEL_LABEL[channel]} automations${q.data ? ` (${q.data.length})` : ""}`}
        description={INTRO[channel]}
        testId={`an-section-${channel}`}
        actions={
          <Button onClick={() => actions.create(channel)} className="gap-1.5" data-testid={`an-new-${channel}`}>
            <Plus size={14} /> New automation
          </Button>
        }
      >
        {q.isError && !q.data ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            The automations could not be loaded: {errorText(q.error) ?? "the server did not answer"}.
            <Button size="sm" variant="outline" onClick={() => void q.refetch()} data-view-safe>
              Try again
            </Button>
          </div>
        ) : !q.data ? (
          <SkeletonRows rows={2} />
        ) : items.length === 0 ? (
          <EmptyNote
            icon={Icon}
            title={`No ${CHANNEL_LABEL[channel]} automation yet`}
            hint="Create one to send an attendance report at the times you pick, for example the morning's absentees at 9:30 AM."
            testId={`an-empty-${channel}`}
            action={
              <Button size="sm" variant="outline" className="mt-1 gap-1.5" onClick={() => actions.create(channel)}>
                <Plus size={14} /> New automation
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2" data-testid={`an-cards-${channel}`}>
            {items.map((a) => (
              <AutomationCard key={a.id} a={a} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
