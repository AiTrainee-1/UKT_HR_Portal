import { Link } from "wouter";
import { Switch } from "@/components/ui/switch";
import { SWITCH_RULES, sectionDirty, switchesAdvice, type SectionProps } from "./logic";
import { Notice, Panel, ReloadButton, SaveRow, SettingBlock } from "./ui";

/**
 * Settings > Switches: which of the three code features are on. They only matter while codes go by SMS (while the channel is
 * WhatsApp, the matching switches in WhatsApp Control decide). One Save for the section.
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
  channel,
}: SectionProps & {
  /** The channel that is saved: the switches below act only while it is SMS. */
  channel: "whatsapp" | "sms";
}) {
  const dirty = sectionDirty("switches", draft, saved);
  const advice = switchesAdvice(draft);
  return (
    <Panel
      title="Switches"
      description="Choose which code features employees can use when codes go by SMS."
      testId="sms-section-switches"
    >
      <Notice tone={channel === "sms" ? "good" : "info"} testId="sms-switches-channel-note">
        {channel === "sms" ? (
          <>Codes go by SMS now, so these switches are in force.</>
        ) : (
          <>
            Codes go by WhatsApp now, so these switches are kept for later and do nothing yet. While WhatsApp is the
            channel, the matching switches in{" "}
            <Link href="/hr/whatsapp-control" className="font-semibold underline underline-offset-2">
              WhatsApp Control
            </Link>{" "}
            decide.
          </>
        )}
      </Notice>

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
            <div className="flex items-start gap-3">
              <Switch
                id={`sms-switch-${rule.key}`}
                checked={checked}
                onCheckedChange={(next) => patch({ [rule.key]: next })}
                disabled={readOnly || busy}
                aria-labelledby={labelId}
                data-testid={`sms-switch-${rule.key}`}
                className="mt-0.5"
              />
              <p className="min-w-0 text-sm font-semibold" aria-live="polite">
                {checked ? rule.on : rule.off}
              </p>
            </div>
          </SettingBlock>
        );
      })}

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
        saveLabel="Save switches"
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </Panel>
  );
}
