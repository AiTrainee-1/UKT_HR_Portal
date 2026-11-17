import { ArrowRight, BellRing, PowerOff, ToggleLeft, UserCog } from "lucide-react";
import { Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWhatsAppControlSettings, useWhatsAppControlTemplates } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { hodStatus, switchCounts, switchedOffSummary } from "./logic";
import { Notice } from "./kit";

const LINK = "inline-flex items-center gap-1 font-bold underline underline-offset-2 hover:no-underline";

function ControlsLink({ onOpen, label = "Open Feature Controls" }: { onOpen?: () => void; label?: string }) {
  if (!onOpen) return null;
  return (
    <button type="button" className={LINK} onClick={onOpen} data-testid="wa-open-controls">
      {label} <ArrowRight size={12} />
    </button>
  );
}

/**
 * The banner at the top of the Overview when HR's switches keep messages from going out: the engine OFF (nothing at all),
 * or most message types switched off, with which ones and a way to Feature Controls. Read from the message types
 * (Message Text's list, the server's own on/off per type); when that list is not open to the role, from the switches.
 */
export function SwitchedOffBanner({
  canReadTypes,
  onOpenControls,
}: {
  /** The Message Text tab is open to the role (its list is what says, per type, whether it can go). */
  canReadTypes: boolean;
  onOpenControls?: () => void;
}) {
  const settings = useWhatsAppControlSettings();
  const templates = useWhatsAppControlTemplates(canReadTypes);
  if (!settings.data) return null;
  const engineOn = settings.data.engineEnabled !== false;

  if (!engineOn) {
    return (
      <div data-testid="wa-switched-off-banner" data-level="engine-off">
        <Notice tone="bad" icon={PowerOff} title="The WhatsApp engine is OFF: no WhatsApp message is sent at all">
          Not even login codes. Turn it back on at the top of Feature Controls. <ControlsLink onOpen={onOpenControls} />
        </Notice>
      </div>
    );
  }

  if (!templates.data) {
    // the per-type list is not open to this role (or not in yet): the switches themselves tell enough
    if (canReadTypes && templates.isPending) return null;
    const { total, off } = switchCounts(settings.data);
    if (total === 0 || off * 2 <= total) return null;
    return (
      <div data-testid="wa-switched-off-banner" data-level="most">
        <Notice tone="warn" icon={ToggleLeft} title="Most WhatsApp messages are switched off">
          {off} of {total} switches on Feature Controls are OFF, so those messages are never sent.{" "}
          <ControlsLink onOpen={onOpenControls} />
        </Notice>
      </div>
    );
  }

  const s = switchedOffSummary(templates.data, engineOn);
  if (s.level === "none") return null;
  const modules = s.offByModule.map((m) => `${m.label} (${m.count})`).join(" · ");
  if (s.level === "some") {
    return (
      <div data-testid="wa-switched-off-banner" data-level="some">
        <Notice tone="neutral" icon={ToggleLeft}>
          {s.off.length} of {s.total} message types are switched off and never sent: {modules}.{" "}
          <ControlsLink onOpen={onOpenControls} label="Feature Controls" />
        </Notice>
      </div>
    );
  }
  return (
    <div data-testid="wa-switched-off-banner" data-level="most">
      <Notice
        tone="warn"
        icon={ToggleLeft}
        title={`Most WhatsApp messages are switched off: ${s.off.length} of ${s.total} message types are never sent`}
      >
        <p>
          Switched off: <span data-testid="wa-switched-off-modules">{modules}</span>.
        </p>
        <p className="mt-1">
          {s.on.length === 0 ? (
            "Nothing can go out until a switch is turned on."
          ) : (
            <>
              Only these can go out: <b data-testid="wa-switched-on-types">{s.on.map((t) => t.label).join(", ")}</b>.
            </>
          )}{" "}
          <ControlsLink onOpen={onOpenControls} />
        </p>
      </Notice>
    </div>
  );
}

/** The Department Head notifications at a glance (owner's priority, 2026-11-17): the section switch, the new-request
 *  message and the scheduled reminder, each on or off (and why), with the ways to change them. */
export function HodStatusCard({ onOpenControls }: { onOpenControls?: () => void }) {
  const settings = useWhatsAppControlSettings();
  if (!settings.data) return null;
  const hod = hodStatus(settings.data);
  if (!hod) return null;
  const badge =
    hod.state === "on"
      ? { tone: "success" as const, label: "ON" }
      : hod.state === "partly"
        ? { tone: "warning" as const, label: "Partly on" }
        : { tone: "danger" as const, label: "OFF" };
  const holder = !hod.engineOn
    ? "the WhatsApp engine is OFF"
    : hod.master && !hod.master.enabled
      ? `"${hod.master.label}" is OFF`
      : null;
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 text-gray-900 shadow-sm"
      data-testid="wa-hod-status"
      data-state={hod.state}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="rounded-xl bg-emerald-50 p-2 text-emerald-700">
            <UserCog size={16} />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
              Department Head notifications <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              WhatsApp to a Department Head when a request waits for them, and the scheduled reminder of everything
              pending.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-blue-700">
          <ControlsLink onOpen={onOpenControls} label="Feature Controls" />
          <Link href="/hr/requests?tab=notify" className={LINK} data-testid="wa-open-notify">
            <BellRing size={12} /> Reminder times (Requests → Notify)
          </Link>
        </div>
      </div>
      {holder && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800" data-testid="wa-hod-held">
          Nothing goes to the heads: {holder}.
        </p>
      )}
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {hod.items.map((i) => (
          <li
            key={i.feature.key}
            className={cn(
              "flex items-start justify-between gap-3 rounded-xl border px-3 py-2",
              i.on ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50",
            )}
            data-testid={`wa-hod-item-${i.feature.key}`}
            data-on={i.on ? "true" : "false"}
          >
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-900">{i.feature.label}</p>
              <p className="text-[11px] text-gray-500">
                {i.on
                  ? "Sent"
                  : i.held
                    ? "Its own switch is ON, but it is held back (see above)"
                    : "Its own switch is OFF"}
              </p>
            </div>
            <span className={cn("text-xs font-black", i.on ? "text-emerald-700" : "text-gray-400")}>
              {i.on ? "ON" : "OFF"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
