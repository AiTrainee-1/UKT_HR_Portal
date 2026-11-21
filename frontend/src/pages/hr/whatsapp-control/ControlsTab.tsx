import { useState } from "react";
import { ArrowRight, FilePlus2, Info, Power, PowerOff, SlidersHorizontal, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useMetaTemplates,
  useUpdateWhatsAppControlSettings,
  useWhatsAppControlSettings,
  useWhatsAppUsage,
  whatsAppErrorMessage,
  type WhatsAppFeature,
  type WhatsAppTiming,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip, Dot, Notice, Panel, TemplateStatusChip } from "./kit";
import {
  controlSections,
  controlSummary,
  formatCount,
  monthOf,
  offReasonText,
  type ControlSection,
  type TypeRow,
} from "./logic";
import QueueCard from "./QueueCard";
import SendingLimits from "./SendingLimits";
import TemplateEditorDialog from "./TemplateEditor";
import { ConfirmDialog } from "./shared";
import type { WaAccess, WaTab } from "./tabs";

/** The timing that belongs to the OTP tab (a code's life), not to the message alerts. */
const OTP_TIMINGS = ["otpExpiryMinutes"];

/** The master switch. It never flips straight away: HR confirms first, both ways. */
function EngineSwitch({
  on,
  disabled,
  onRequest,
}: {
  on: boolean;
  disabled: boolean;
  onRequest: (next: boolean) => void;
}) {
  const Icon = on ? Power : PowerOff;
  return (
    <section
      data-testid="wa-engine"
      data-state={on ? "on" : "off"}
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-3xl border p-5 shadow-sm",
        on
          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
          : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950",
      )}
    >
      <div className="flex min-w-0 items-start gap-3.5">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white",
            on ? "bg-emerald-600" : "bg-red-600",
          )}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0">
          <p className="text-lg font-bold leading-tight">WhatsApp engine</p>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
            {on
              ? "ON: every switched-on message below goes out as its approved Meta template, one at a time through the sending queue."
              : "OFF: nothing is sent by WhatsApp, not even sign-in codes. Password sign-in, and SMS codes where switched on, keep working."}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className={cn(
            "w-9 text-right text-sm font-black",
            on ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300",
          )}
        >
          {on ? "ON" : "OFF"}
        </span>
        <Switch
          checked={on}
          disabled={disabled}
          onCheckedChange={onRequest}
          aria-label="WhatsApp engine"
          data-testid="wa-engine-switch"
        />
      </div>
    </section>
  );
}

function SwitchRow({
  feature,
  disabled,
  onToggle,
  held,
}: {
  feature: WhatsAppFeature;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  held?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5" data-testid={`wa-switch-row-${feature.key}`}>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold">{feature.label}</p>
        {feature.description && <p className="mt-0.5 text-xs text-muted-foreground">{feature.description}</p>}
        {held && feature.enabled && (
          <p className="mt-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            Held: the section is OFF.
          </p>
        )}
      </div>
      <Switch
        checked={feature.enabled}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={feature.label}
        data-testid={`toggle-${feature.key}`}
      />
    </div>
  );
}

function TypeLine({
  row,
  disabled,
  onToggle,
  onCreate,
}: {
  row: TypeRow;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onCreate?: () => void;
}) {
  const f = row.feature;
  const live = row.off === null;
  const never = row.off === "none"; // not sent through Meta at all: its switch changes nothing
  const needsTemplate =
    row.templateState !== null && ["missing", "rejected", "disabled", "paused"].includes(row.templateState);
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_5.5rem_auto]"
      data-testid={`wa-type-${row.type}`}
      data-off={row.off ?? undefined}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-semibold">
          <Dot tone={live ? "good" : row.off === "template" ? "warn" : "neutral"}>{f.label}</Dot>
        </p>
        {f.description && <p className="mt-0.5 pl-3.5 text-xs text-muted-foreground">{f.description}</p>}
        {row.off && (
          <p
            className={cn(
              "mt-0.5 pl-3.5 text-[11px] font-semibold",
              row.off === "template" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
            )}
            data-testid={`wa-type-off-${row.type}`}
          >
            {offReasonText(row)}
          </p>
        )}
      </div>
      <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-3.5 sm:col-start-auto sm:row-start-auto sm:pl-0">
        {row.templateName === null ? (
          <TemplateStatusChip state="none" />
        ) : (
          <>
            <code
              className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
              title={row.templateName}
            >
              {row.templateName}
            </code>
            {row.templateState !== null && (
              <TemplateStatusChip state={row.templateState} testId={`wa-type-template-${row.type}`} />
            )}
            {needsTemplate && onCreate && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={onCreate}
                data-testid={`wa-type-create-${row.type}`}
              >
                <FilePlus2 size={11} /> Create template
              </Button>
            )}
          </>
        )}
      </div>
      <p
        className="hidden text-right text-xs text-muted-foreground sm:block"
        data-testid={`wa-type-count-${row.type}`}
        title="Messages of this type this month"
      >
        {row.monthCount === null ? (
          ""
        ) : (
          <>
            <b className="tabular-nums text-foreground">{formatCount(row.monthCount)}</b> this month
          </>
        )}
      </p>
      <div className="col-start-2 row-span-2 row-start-1 flex items-center gap-2 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
        <Switch
          checked={f.enabled && !never}
          disabled={disabled || never}
          onCheckedChange={onToggle}
          aria-label={`WhatsApp ${f.label}`}
          data-testid={`toggle-${f.key}`}
        />
      </div>
    </div>
  );
}

function SectionCard({
  section,
  engineOn,
  disabled,
  toggle,
  onCreate,
  access,
  go,
}: {
  section: ControlSection;
  engineOn: boolean;
  disabled: boolean;
  toggle: (f: WhatsAppFeature, enabled: boolean) => void;
  onCreate?: (row: TypeRow) => void;
  access: WaAccess;
  go: (tab: WaTab) => void;
}) {
  const { group, master, general, types } = section;
  const held = master !== null && !master.enabled;
  const live = types.filter((t) => t.off === null).length;
  const sendable = types.filter((t) => t.off !== "none").length;
  return (
    <section
      className={cn(
        "min-w-0 rounded-2xl border bg-card text-card-foreground shadow-sm transition-opacity",
        !engineOn && "opacity-70",
      )}
      data-testid={`wa-feature-group-${group.key}`}
      data-held={held ? "true" : undefined}
      data-inactive={engineOn ? undefined : "true"}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {group.title}
            <span className="text-xs font-medium text-muted-foreground" data-testid={`wa-section-count-${group.key}`}>
              {live} of {sendable} going out
            </span>
          </h3>
          {group.blurb && <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{group.blurb}</p>}
        </div>
        {master && (
          <div className="flex items-center gap-2.5" data-testid={`wa-section-master-${group.key}`}>
            <Chip tone={master.enabled ? "good" : "bad"} testId={`wa-section-state-${group.key}`}>
              {master.enabled ? "Section ON" : "Section OFF"}
            </Chip>
            <Switch
              checked={master.enabled}
              disabled={disabled}
              onCheckedChange={(v) => toggle(master, v)}
              aria-label={master.label}
              data-testid={`toggle-${master.key}`}
            />
          </div>
        )}
      </header>
      <div className="px-4 sm:px-5">
        {held && (
          <Notice tone="warn" className="mt-3" testId={`wa-section-held-${group.key}`}>
            &ldquo;{master!.label}&rdquo; is OFF, so nothing in this section is sent, whatever the switches below say.
          </Notice>
        )}
        {group.key === "signin" && (
          <Notice tone="info" className="mt-3" icon={Info}>
            The WhatsApp OTP master switch, the code's expiry and password sign-in are on the{" "}
            {access.canOpen("otp") ? (
              <button type="button" className="font-semibold underline underline-offset-2" onClick={() => go("otp")}>
                OTP tab
              </button>
            ) : (
              "OTP tab"
            )}
            . SMS codes are separate (SMS Control).
          </Notice>
        )}
        {general.length > 0 && (
          <div className="divide-y border-b">
            {general.map((f) => (
              <SwitchRow key={f.key} feature={f} disabled={disabled} onToggle={(v) => toggle(f, v)} held={held} />
            ))}
          </div>
        )}
        <div className="divide-y">
          {types.map((row) => (
            <TypeLine
              key={row.type}
              row={row}
              disabled={disabled}
              onToggle={(v) => toggle(row.feature, v)}
              onCreate={onCreate ? () => onCreate(row) : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Timings({ timings, disabled }: { timings: WhatsAppTiming[]; disabled: boolean }) {
  const { toast } = useToast();
  const update = useUpdateWhatsAppControlSettings();
  const draftOf = () => Object.fromEntries(timings.map((t) => [t.key, String(t.value)]));
  const [draft, setDraft] = useState<Record<string, string>>(draftOf);
  const savedKey = JSON.stringify(timings.map((t) => [t.key, t.value]));
  const [seen, setSeen] = useState(savedKey);
  if (seen !== savedKey) {
    setSeen(savedKey);
    setDraft(draftOf());
  }
  if (timings.length === 0) return null;
  const invalid = timings.some((t) => {
    const n = Number(draft[t.key]);
    return draft[t.key]?.trim() === "" || !Number.isInteger(n) || n < t.min || n > t.max;
  });
  const changed = timings.some((t) => String(t.value) !== draft[t.key]);
  const save = () =>
    update.mutate(Object.fromEntries(timings.map((t) => [t.key, Number(draft[t.key])])), {
      onSuccess: () => toast({ title: "Timings saved", description: "They apply from the next check." }),
      onError: (e) =>
        toast({
          title: "Couldn't save the timings",
          description: whatsAppErrorMessage(e, "Try again."),
          variant: "destructive",
        }),
    });
  return (
    <Panel
      title="Alert timings"
      description="The shift's own grace period always applies first; these add to it."
      icon={Timer}
      testId="wa-timings"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {timings.map((t) => (
          <div key={t.key} className="space-y-1.5">
            <Label className="text-xs" htmlFor={`timing-${t.key}`}>
              {t.label}
            </Label>
            <Input
              id={`timing-${t.key}`}
              type="number"
              min={t.min}
              max={t.max}
              value={draft[t.key] ?? ""}
              disabled={disabled}
              onChange={(e) => setDraft((prev) => ({ ...prev, [t.key]: e.target.value }))}
              className="w-32"
            />
            <p className="text-[10px] text-muted-foreground">
              {t.min}–{t.max}
            </p>
          </div>
        ))}
      </div>
      <Button size="sm" className="mt-3" onClick={save} disabled={disabled || !changed || invalid || update.isPending}>
        {update.isPending ? "Saving…" : "Save timings"}
      </Button>
    </Panel>
  );
}

/** Message Controls: the engine, then every module with its section switch and each message type with its own switch,
 *  its Meta template and status, this month's count and "Create template" when it has none; then the sending limits,
 *  quiet hours, the alert timings and today's queue. */
export default function ControlsTab({ access, go }: { access: WaAccess; go: (tab: WaTab) => void }) {
  const { toast } = useToast();
  const canEdit = access.canEdit("controls");
  const { data, isLoading, error } = useWhatsAppControlSettings();
  const templates = useMetaTemplates(access.canOpen("templates")).data ?? null;
  const usage = useWhatsAppUsage(monthOf(new Date()), access.canOpen("usage")).data ?? null;
  const update = useUpdateWhatsAppControlSettings();
  const [engineAsk, setEngineAsk] = useState({ open: false, target: true });
  const [editor, setEditor] = useState<{ type: string; label: string } | null>(null);
  const closeEngineAsk = () => setEngineAsk((ask) => ({ ...ask, open: false }));

  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (!data) {
    return (
      <Notice tone="bad" role="alert" title="The switches could not be loaded" testId="wa-controls-error">
        {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
      </Notice>
    );
  }

  const engineOn = data.engineEnabled;
  const sections = controlSections(data, templates?.templates ?? null, usage?.byType ?? null);
  const summary = controlSummary(sections);
  const disabled = !canEdit || update.isPending;
  const canCreate = access.canEdit("templates") && templates !== null && templates.configured;

  const toggle = (feature: WhatsAppFeature, enabled: boolean) =>
    update.mutate(
      { [feature.key]: enabled },
      {
        onSuccess: () => toast({ title: `${feature.label}: ${enabled ? "ON" : "OFF"}` }),
        onError: (e) =>
          toast({
            title: "Couldn't change that switch",
            description: whatsAppErrorMessage(e, "Try again."),
            variant: "destructive",
          }),
      },
    );

  const setEngine = (next: boolean) =>
    update.mutate(
      { engineEnabled: next },
      {
        onSuccess: () => {
          closeEngineAsk();
          toast({
            title: `WhatsApp engine: ${next ? "ON" : "OFF"}`,
            description: next ? "Messages go out through the sending queue again." : "Nothing is sent by WhatsApp now.",
          });
        },
        onError: (e) => {
          closeEngineAsk();
          toast({
            title: "Couldn't change the WhatsApp engine",
            description: whatsAppErrorMessage(e, "Try again."),
            variant: "destructive",
          });
        },
      },
    );

  return (
    <div className="space-y-4" data-testid="wa-controls">
      <EngineSwitch on={engineOn} disabled={disabled} onRequest={(target) => setEngineAsk({ open: true, target })} />

      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-2xl border bg-card px-4 py-3 text-[13px] shadow-sm"
        data-testid="wa-controls-summary"
      >
        <span className="flex items-center gap-1.5 font-semibold">
          <SlidersHorizontal size={14} className="text-emerald-600 dark:text-emerald-400" />
          {summary.live} of {summary.total} message types go out
        </span>
        {summary.off > 0 && <Dot tone="neutral">{summary.off} switched off</Dot>}
        {summary.noTemplate > 0 && (
          <span className="flex items-center gap-2">
            <Dot tone="warn">{summary.noTemplate} wait for a template</Dot>
            {access.canOpen("templates") && (
              <button
                type="button"
                onClick={() => go("templates")}
                className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline dark:text-sky-300"
              >
                Templates <ArrowRight size={11} />
              </button>
            )}
          </span>
        )}
        {templates === null && access.canOpen("templates") && (
          <span className="text-xs text-muted-foreground">Reading the templates…</span>
        )}
      </div>

      {!engineOn && (
        <Notice tone="neutral" icon={PowerOff} testId="wa-engine-off-note">
          The WhatsApp engine is <b>OFF</b>, so none of the switches below send anything until it is turned back on. You
          can still set them now; they apply once the engine is ON.
        </Notice>
      )}
      <Notice tone="info">
        A message goes out only when its switch, its section and the engine are ON <b>and</b> Meta has approved its
        template. Attendance alerts and punch reminders start OFF: turning one ON begins messaging real employees, so
        try it on a quiet day and watch the Messages tab. Changes apply within a minute; no restart is needed.
      </Notice>

      {sections.map((section) => (
        <SectionCard
          key={section.group.key}
          section={section}
          engineOn={engineOn}
          disabled={disabled}
          toggle={toggle}
          onCreate={canCreate ? (row) => setEditor({ type: row.type, label: row.feature.label }) : undefined}
          access={access}
          go={go}
        />
      ))}

      {(data.queueLimits.length > 0 || data.quietHours) && (
        <SendingLimits limits={data.queueLimits} quietHours={data.quietHours} locked={!canEdit} />
      )}
      <Timings timings={data.timings.filter((t) => !OTP_TIMINGS.includes(t.key))} disabled={!canEdit} />
      {/* the server files "Clear queue" under the Overview tab (permission_tree.py whatsapp_control.overview) */}
      {access.canOpen("overview") && <QueueCard locked={!access.canEdit("overview")} />}

      <TemplateEditorDialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        messageType={editor?.type ?? null}
        label={editor?.label ?? null}
      />

      <ConfirmDialog
        open={engineAsk.open}
        title={engineAsk.target ? "Turn the WhatsApp engine ON?" : "Turn the WhatsApp engine OFF?"}
        confirmLabel={engineAsk.target ? "Turn ON" : "Turn OFF"}
        destructive={!engineAsk.target}
        pending={update.isPending}
        onConfirm={() => setEngine(engineAsk.target)}
        onCancel={closeEngineAsk}
        testId="wa-engine-confirm"
      >
        {engineAsk.target ? (
          <>
            <p>
              WhatsApp messages start going out again, one at a time through the sending queue and within the limits.
            </p>
            <p>Message types switched OFF below stay off.</p>
          </>
        ) : (
          <>
            <p>
              No WhatsApp message will be sent from UK Textiles HRMS: attendance alerts, approvals, documents, visitor
              and gate messages all stop.
            </p>
            <p>
              <b>One-time sign-in codes will not go by WhatsApp either.</b> Employees can still sign in with their
              password, or with an SMS code where SMS codes are switched on.
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
