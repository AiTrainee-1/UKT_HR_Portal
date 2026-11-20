import { Link } from "wouter";
import { KeyRound, MessageSquareText, ShieldCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  CODES_ONLY_TEXT,
  INDEPENDENT_TEXT,
  MASTER_RULE,
  SWITCH_RULES,
  sectionDirty,
  switchOnBlockedReason,
  switchesAdvice,
  type SectionProps,
} from "./logic";
import { smsPath } from "./routes";
import { AffectList, Notice, OnOff, Panel, ReloadButton, SaveRow, SettingBlock } from "./ui";

/**
 * Settings > OTP Switches: SMS codes on or off (the master switch), and what they may be used for (sign-in, password reset,
 * first-time activation). WhatsApp codes have their own switches on WhatsApp Control and are not touched here: either channel
 * alone is enough. SMS codes cannot be switched on while 2Factor is not set up. One Save for the section; switching the
 * master asks first (SettingsTab).
 */
export default function SwitchesSection({
  draft,
  saved,
  patch,
  readOnly,
  saving,
  busy,
  error,
  stale,
  onSave,
  onDiscard,
  onReload,
  configured,
}: SectionProps & {
  /** 2Factor is set up on the server (null until the overview has loaded). */
  configured: boolean | null;
}) {
  const dirty = sectionDirty("switches", draft, saved);
  const advice = switchesAdvice(draft);
  const blocked = switchOnBlockedReason(configured, saved.otpEnabled);
  // switched on in the form while 2Factor is not set up: Save has to wait
  const invalid = blocked !== null && draft.otpEnabled;
  const locked = readOnly || busy;

  return (
    <Panel
      title="OTP Switches"
      description="Whether employees can get one-time codes by SMS, and what for."
      testId="sms-section-switches"
    >
      <div className="mb-4 grid gap-2 lg:grid-cols-2">
        <Notice tone="info" icon={KeyRound} testId="sms-switches-independent">
          {INDEPENDENT_TEXT}{" "}
          <Link href="/hr/whatsapp-control" className="font-semibold underline underline-offset-2">
            WhatsApp Control
          </Link>
        </Notice>
        <Notice tone="good" icon={ShieldCheck} testId="sms-switches-codes-only">
          {CODES_ONLY_TEXT}
        </Notice>
      </div>

      {/* the master switch, drawn bigger than the rest: it decides whether any SMS goes out at all */}
      <div
        className={cn(
          "rounded-2xl border p-4 sm:p-5",
          draft.otpEnabled
            ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
            : "bg-muted",
        )}
        data-testid="sms-master"
        data-on={draft.otpEnabled ? "true" : "false"}
      >
        <div className="flex flex-wrap items-start gap-4">
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-card shadow-sm",
              draft.otpEnabled ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
            )}
          >
            <MessageSquareText size={20} />
          </span>
          <div className="min-w-0 flex-1 basis-60 space-y-1">
            <h4 id="sms-master-label" className="text-base font-bold">
              {MASTER_RULE.title}
            </h4>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{MASTER_RULE.purpose}</p>
          </div>
          <div className="flex items-center gap-2.5">
            <OnOff on={draft.otpEnabled} />
            <Switch
              id="sms-switch-otpEnabled"
              checked={draft.otpEnabled}
              onCheckedChange={(next) => patch({ otpEnabled: next })}
              disabled={locked || (blocked !== null && !draft.otpEnabled)}
              aria-labelledby="sms-master-label"
              aria-describedby={blocked ? "sms-master-blocked" : undefined}
              data-testid="sms-switch-otpEnabled"
            />
          </div>
        </div>
        <p className="mt-3 text-sm font-semibold" aria-live="polite" data-testid="sms-master-state">
          {draft.otpEnabled ? MASTER_RULE.on : MASTER_RULE.off}
        </p>
        <div className="mt-3">
          <AffectList affects={MASTER_RULE.affects} />
        </div>
        {blocked && (
          <Notice tone="warn" className="mt-3" testId="sms-master-blocked">
            <span id="sms-master-blocked">{blocked}</span>{" "}
            <Link href={smsPath("setup")} className="font-semibold underline underline-offset-2">
              Open Setup
            </Link>
          </Notice>
        )}
        {draft.otpEnabled !== saved.otpEnabled && (
          <Notice tone="info" className="mt-3" testId="sms-master-pending">
            You switched SMS codes <b>{draft.otpEnabled ? "on" : "off"}</b>. Nothing changes until you save, and saving
            asks you to confirm.
          </Notice>
        )}
      </div>

      <div className="mt-2" data-testid="sms-purposes" data-master={draft.otpEnabled ? "on" : "off"}>
        {!draft.otpEnabled && (
          <p className="mt-3 text-xs font-medium text-muted-foreground" data-testid="sms-purposes-kept">
            While SMS codes are off, these are kept as they are for when they are switched on again.
          </p>
        )}
        {SWITCH_RULES.map((rule) => {
          const checked = draft[rule.key];
          const labelId = `sms-${rule.key}-label`;
          return (
            <SettingBlock
              key={rule.key}
              id={rule.key}
              title={<span id={labelId}>{rule.title}</span>}
              purpose={rule.purpose}
              affects={rule.affects}
              defaultText="On"
            >
              <div className={cn("flex items-start gap-3", !draft.otpEnabled && "opacity-60")}>
                <Switch
                  id={`sms-switch-${rule.key}`}
                  checked={checked}
                  onCheckedChange={(next) => patch({ [rule.key]: next })}
                  disabled={locked}
                  aria-labelledby={labelId}
                  data-testid={`sms-switch-${rule.key}`}
                  className="mt-0.5"
                />
                <p className="min-w-0 text-sm font-semibold" aria-live="polite">
                  {checked ? rule.on : rule.off}
                  {checked && !draft.otpEnabled && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      (only once SMS codes are switched on)
                    </span>
                  )}
                </p>
              </div>
            </SettingBlock>
          );
        })}
      </div>

      {advice.length > 0 && (
        <Notice tone="warn" testId="sms-switches-advice">
          {advice.join(" ")}
        </Notice>
      )}
      {error && (
        <Notice tone="bad" role="alert" testId="sms-switches-error">
          <p>{error}</p>
          {stale && <ReloadButton onReload={onReload} />}
        </Notice>
      )}
      <SaveRow
        testId="sms-switches-save-row"
        dirty={dirty}
        saving={saving}
        readOnly={readOnly}
        invalid={invalid}
        saveLabel="Save switches"
        onSave={onSave}
        onDiscard={onDiscard}
        hint={!readOnly && dirty && invalid ? (blocked ?? undefined) : undefined}
      />
    </Panel>
  );
}
