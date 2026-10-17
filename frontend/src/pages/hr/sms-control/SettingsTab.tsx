import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  isStaleSettingsError,
  useSmsOverview,
  useSmsSettings,
  useUpdateSmsSettings,
  type SmsSettings,
} from "@/lib/api-client/custom-hooks";
import ChannelSection from "./ChannelSection";
import LimitsSection from "./LimitsSection";
import SwitchesSection from "./SwitchesSection";
import {
  CHANNEL_LABEL,
  PROVIDER_NAME,
  STALE_TEXT,
  buildInput,
  draftFrom,
  failureText,
  formatWhen,
  sectionDirty,
  validateLimits,
  withSection,
  type SectionProps,
  type SettingsDraft,
} from "./logic";
import { SETTINGS_SECTIONS, SMS_BASE, type SettingsSectionKey } from "./routes";
import { ConfirmDialog, Notice } from "./ui";

const SECTIONS: readonly SettingsSectionKey[] = SETTINGS_SECTIONS.map((s) => s.value);

/**
 * Settings: the channel, the limits and the switches, one section at a time (the nested tabs are in the path). The form lives
 * HERE, above the sections, so what was typed in one is still there after a look at another. Each section has its own Save,
 * which sends the saved values with that section's fields changed, and the `version` the form was started from: a copy that
 * somebody else has outdated is refused (and the form is kept until HR chooses to reload). Switching the channel asks first.
 */
export default function SettingsTab({ section, readOnly }: { section: SettingsSectionKey; readOnly: boolean }) {
  const { toast } = useToast();
  const query = useSmsSettings();
  const update = useUpdateSmsSettings();
  const overview = useSmsOverview();
  const data = query.data;

  const saved = useMemo(() => (data ? draftFrom(data) : null), [data]);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  // the `version` the form was started from: it follows the server while nothing is edited, and stays put while there are edits
  const [baseVersion, setBaseVersion] = useState<string | undefined>(undefined);
  const [seen, setSeen] = useState<SmsSettings | undefined>(undefined);
  if (data && data !== seen) {
    setSeen(data);
    const before = seen ? draftFrom(seen) : null;
    const clean = draft === null || before === null || SECTIONS.every((s) => !sectionDirty(s, draft, before));
    if (clean) {
      setDraft(draftFrom(data));
      setBaseVersion(data.version);
    }
  }

  const [savingSection, setSavingSection] = useState<SettingsSectionKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SettingsSectionKey, string>>>({});
  const [stale, setStale] = useState(false);
  const [confirmingChannel, setConfirmingChannel] = useState(false);
  const [confirmingReload, setConfirmingReload] = useState(false);

  if (query.isLoading || (data && !draft)) {
    return (
      <div className="space-y-3" data-testid="sms-settings-loading">
        <Skeleton className="h-10 w-72 rounded-xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    );
  }

  if (query.isError || !data || !draft || !saved) {
    return (
      <Notice tone="bad" role="alert" testId="sms-settings-error">
        <div className="flex flex-wrap items-center gap-3">
          <span>The SMS settings could not be loaded. Check the connection and try again.</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  }

  const anyDirty = SECTIONS.some((s) => sectionDirty(s, draft, saved));
  const ready = overview.data ? overview.data.configured : null;

  const patch = (change: Partial<SettingsDraft>) => setDraft((d) => (d ? { ...d, ...change } : d));

  const save = async (which: SettingsSectionKey) => {
    setConfirmingChannel(false);
    setSavingSection(which);
    setErrors((e) => ({ ...e, [which]: undefined }));
    setStale(false);
    try {
      const result = await update.mutateAsync(buildInput(data, draft, which, baseVersion));
      setDraft((d) => (d ? withSection(which, d, draftFrom(result)) : draftFrom(result)));
      setBaseVersion(result.version);
      toast({
        title: which === "channel" ? `Codes now go by ${CHANNEL_LABEL[result.otpChannel]}` : "Settings saved",
        description:
          (result.warnings?.length ?? 0) > 0
            ? `Saved, with a warning: ${(result.warnings ?? []).join(" ")}`
            : "The change applies from the next code that is asked for.",
      });
    } catch (err) {
      const staleCopy = isStaleSettingsError(err);
      const message = staleCopy ? STALE_TEXT : failureText(err, "save the SMS settings");
      if (staleCopy) setStale(true);
      setErrors((e) => ({ ...e, [which]: message }));
      toast({ title: "The SMS settings were not saved", description: message, variant: "destructive" });
    } finally {
      setSavingSection(null);
    }
  };

  const requestSave = (which: SettingsSectionKey) => {
    if (which === "limits" && validateLimits(draft).first !== null) return;
    // switching the channel decides what every employee receives: say so and ask first
    if (which === "channel" && draft.otpChannel !== saved.otpChannel) {
      setConfirmingChannel(true);
      return;
    }
    void save(which);
  };

  const discard = (which: SettingsSectionKey) => {
    setDraft((d) => (d ? withSection(which, d, saved) : d));
    setErrors((e) => ({ ...e, [which]: undefined }));
  };

  // read what is saved now and start the form from it: whatever was typed is dropped
  const reload = async () => {
    setConfirmingReload(false);
    const fresh = (await query.refetch()).data;
    if (!fresh) return;
    setDraft(draftFrom(fresh));
    setBaseVersion(fresh.version);
    setErrors({});
    setStale(false);
  };

  const common = (which: SettingsSectionKey): SectionProps => ({
    draft,
    saved,
    patch,
    readOnly,
    saving: savingSection === which,
    busy: savingSection !== null,
    error: errors[which] ?? null,
    stale,
    onSave: () => requestSave(which),
    onDiscard: () => discard(which),
    onReload: () => (anyDirty ? setConfirmingReload(true) : void reload()),
  });

  const toSms = draft.otpChannel === "sms";

  return (
    <div className="space-y-4" data-testid="sms-settings">
      {data.updatedAt && (
        <p className="text-xs text-muted-foreground" data-testid="sms-settings-updated">
          Last saved {data.updatedBy ? `by ${data.updatedBy} ` : ""}on {formatWhen(data.updatedAt)}.
        </p>
      )}
      {(data.warnings?.length ?? 0) > 0 && (
        <Notice tone="warn" testId="sms-settings-warnings">
          <p className="font-semibold">The server points out:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {(data.warnings ?? []).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <NestedTabs
        base={`${SMS_BASE}/settings`}
        items={SETTINGS_SECTIONS.map((s) => ({ ...s }))}
        value={section}
        testId="sms-settings-nested"
        label="Sections of Settings"
      >
        {section === "channel" && <ChannelSection {...common("channel")} ready={ready} />}
        {section === "limits" && <LimitsSection {...common("limits")} />}
        {section === "switches" && <SwitchesSection {...common("switches")} channel={data.otpChannel} />}
      </NestedTabs>

      <ConfirmDialog
        open={confirmingChannel}
        title={toSms ? "Send codes by SMS?" : "Send codes by WhatsApp again?"}
        confirmLabel={toSms ? "Yes, use SMS" : "Yes, use WhatsApp"}
        onConfirm={() => void save("channel")}
        onCancel={() => setConfirmingChannel(false)}
        testId="sms-channel-confirm"
      >
        {toSms ? (
          <>
            <p>
              From the next code on, employees get their login, password-reset and activation codes as an SMS from{" "}
              {PROVIDER_NAME} instead of on WhatsApp. WhatsApp keeps sending every other message.
            </p>
            {ready === false && (
              <p className="font-semibold text-amber-700 dark:text-amber-400">
                {PROVIDER_NAME} is not set up on the server yet, so employees will get no code options until it is.
                Password sign-in keeps working.
              </p>
            )}
            <p>Codes already sent on WhatsApp work until they expire. You can switch back at any time.</p>
          </>
        ) : (
          <>
            <p>
              From the next code on, codes go by WhatsApp again, as before. Your SMS limits and switches are kept for
              later.
            </p>
            <p>Codes already sent by SMS work until they expire.</p>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmingReload}
        title="Throw away your changes?"
        confirmLabel="Reload and discard"
        onConfirm={() => void reload()}
        onCancel={() => setConfirmingReload(false)}
        testId="sms-reload-confirm"
      >
        <p>Reloading reads what is saved now and drops everything you typed that is not saved yet.</p>
      </ConfirmDialog>
    </div>
  );
}
