import { LifeBuoy, MessageCircle, MessageSquareText } from "lucide-react";
import type { SmsChannel } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, PROVIDER_NAME, type Affect, type SectionProps } from "./logic";
import { Notice, Panel, ReloadButton, SaveRow, SettingBlock } from "./ui";

/** Why SMS cannot be chosen right now (null when it can): 2Factor is not set up on the server. The server refuses it too; the
 *  page just says so first. A channel that is already SMS is never blocked (it can be left). */
export function smsBlockedReason(configured: boolean | null, savedChannel: SmsChannel): string | null {
  if (configured !== false || savedChannel === "sms") return null;
  return `SMS cannot be chosen yet: ${PROVIDER_NAME} is not set up on the server. Finish its setup (see the Setup tab).`;
}

const CHANNELS: { value: SmsChannel; icon: typeof MessageCircle }[] = [
  { value: "whatsapp", icon: MessageCircle },
  { value: "sms", icon: MessageSquareText },
];

const AFFECTS: Affect[] = [
  {
    where: "Employee web app and mobile app",
    what: "sign in with a code, forgot password and first-time activation use the chosen channel, and their texts say SMS or WhatsApp",
  },
  {
    where: "WhatsApp Control",
    what: "WhatsApp stays in use for every other message (salary slips, alerts, approvals). Only the codes move",
    to: "/hr/whatsapp-control",
  },
  {
    where: "The three switches",
    what: "on SMS, the ones in this page's Switches section decide; on WhatsApp, the ones in WhatsApp Control do",
  },
  {
    where: "Apps that have not been updated",
    what: "still say WhatsApp in their own text, even while codes go by SMS",
  },
];

/**
 * Settings > Channel: whether the login, reset and activation codes go by WhatsApp or by SMS (through 2Factor). One choice, one
 * Save, and a confirmation (in SettingsTab) because it decides what every employee receives from the next code on. SMS cannot be
 * chosen while 2Factor is not set up.
 */
export default function ChannelSection({
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
  ready,
}: SectionProps & {
  /** 2Factor is set up on the server (null until the overview has loaded). */
  ready: boolean | null;
}) {
  const dirty = draft.otpChannel !== saved.otpChannel;
  const blocked = smsBlockedReason(ready, saved.otpChannel);
  // SMS is in the form (chosen before the overview said 2Factor is not set up): Save has to wait
  const invalid = blocked !== null && draft.otpChannel === "sms";
  const locked = readOnly || busy;
  const label = PROVIDER_NAME;

  const channelText: Record<SmsChannel, { title: string; text: string; points: string[] }> = {
    whatsapp: {
      title: "WhatsApp",
      text: "Codes go to the employee's WhatsApp, through WAClient, exactly as they do today.",
      points: ["Free to send", "Needs WhatsApp on the phone and an internet connection"],
    },
    sms: {
      title: `SMS through ${label}`,
      text: `Codes go as a text message to the mobile number HR has on file, through ${label}.`,
      points: [
        "Works on every phone, even without internet",
        "Costs a little for each message",
        `Needs ${label} set up on the server`,
      ],
    },
  };

  return (
    <Panel
      title="Where codes are sent"
      description="Login, password-reset and account-activation codes can go by WhatsApp or by SMS. Pick one."
      testId="sms-section-channel"
    >
      <SettingBlock
        id="channel"
        title={<span id="sms-channel-label">Channel for codes</span>}
        purpose="Only the codes move. Salary slips, alerts, approvals and every other message keep going by WhatsApp."
        affects={AFFECTS}
        defaultText="WhatsApp"
        note={
          <Notice tone="info" testId="sms-never-locked-out">
            <span className="flex items-start gap-1.5">
              <LifeBuoy size={14} className="mt-0.5 shrink-0" />
              <span>
                <b>Nobody is ever locked out.</b> If SMS is chosen but {label} is not ready, the code options simply
                disappear from the login screens and password sign-in keeps working.
              </span>
            </span>
          </Notice>
        }
      >
        <fieldset className="grid gap-3 sm:grid-cols-2" aria-labelledby="sms-channel-label" disabled={locked}>
          {CHANNELS.map(({ value, icon: Icon }) => {
            const checked = draft.otpChannel === value;
            const option = channelText[value];
            const off = value === "sms" && blocked !== null && !checked;
            return (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  checked ? "border-sky-500 bg-sky-50 dark:bg-sky-950/40" : "hover:bg-muted/40",
                  (locked || off) && "cursor-not-allowed opacity-70",
                )}
                data-testid={`sms-channel-${value}`}
                title={off ? (blocked ?? undefined) : undefined}
              >
                <input
                  type="radio"
                  name="sms-channel"
                  value={value}
                  checked={checked}
                  disabled={off}
                  aria-describedby={off ? "sms-channel-blocked" : undefined}
                  onChange={() => patch({ otpChannel: value as SmsChannel })}
                  className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                />
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <Icon size={15} className="shrink-0 text-muted-foreground" />
                    {option.title}
                    {saved.otpChannel === value && (
                      <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                        In use now
                      </span>
                    )}
                  </span>
                  <span className="block text-[13px] leading-snug text-muted-foreground">{option.text}</span>
                  <span className="block space-y-0.5">
                    {option.points.map((point) => (
                      <span key={point} className="block text-[12px] text-muted-foreground">
                        • {point}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {blocked && (
          <Notice tone="warn" testId="sms-channel-blocked">
            <span id="sms-channel-blocked">{blocked}</span>
          </Notice>
        )}
        {dirty && (
          <Notice tone="info" testId="sms-channel-pending">
            You chose <b>{CHANNEL_LABEL[draft.otpChannel]}</b>. Nothing changes until you save, and saving asks you to
            confirm.
          </Notice>
        )}
      </SettingBlock>

      {error && (
        <Notice tone="bad" role="alert" testId="sms-channel-error">
          <p>{error}</p>
          {stale && <ReloadButton onReload={onReload} />}
        </Notice>
      )}
      <SaveRow
        testId="sms-channel-save-row"
        dirty={dirty}
        saving={saving}
        readOnly={readOnly}
        invalid={invalid}
        saveLabel="Save channel"
        onSave={onSave}
        onDiscard={onDiscard}
        hint={!readOnly && dirty && invalid ? (blocked ?? undefined) : undefined}
      />
    </Panel>
  );
}
