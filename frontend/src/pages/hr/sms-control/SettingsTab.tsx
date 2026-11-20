import { useMemo, useState } from "react";
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
import CostSection from "./CostSection";
import LimitsSection from "./LimitsSection";
import SwitchesSection from "./SwitchesSection";
import {
  INDEPENDENT_TEXT,
  PROVIDER_NAME,
  STALE_TEXT,
  buildInput,
  draftFrom,
  failureText,
  formatWhen,
  sectionDirty,
  validateCost,
  validateLimits,
  withSection,
  type SectionProps,
  type SettingsDraft,
} from "./logic";
import { SETTINGS_SECTIONS, SMS_BASE, type SettingsSectionKey } from "./routes";
import { ConfirmDialog, LoadError, Notice } from "./ui";

const SECTIONS: readonly SettingsSectionKey[] = SETTINGS_SECTIONS.map((s) => s.value);

const SAVED_TITLE: Record<SettingsSectionKey, string> = {
  switches: "SMS code switches saved",
  limits: "Limits saved",
  cost: "Price and budget saved",
};

/**
 * Settings: the SMS code switches, the limits, and the price and budget, one section at a time (the nested tabs are in the
 * path). The form lives HERE, above the sections, so what was typed in one is still there after a look at another. Each
 * section has its own Save, which sends only that section's fields and the `version` the form was started from: a copy that
 * somebody else has outdated is refused (and the form is kept until HR chooses to reload). Switching SMS codes on or off asks
 * first, because it decides what every employee is offered from the next code on.
 */
export default function SettingsTab({
  section,
  readOnly,
  sections = SECTIONS,
}: {
  section: SettingsSectionKey;
  readOnly: boolean;
  /** The sections the role may open (each has its own permission key); the others are not offered. */
  sections?: readonly SettingsSectionKey[];
}) {
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
  const [confirmingMaster, setConfirmingMaster] = useState(false);
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
    return <LoadError what="The SMS settings" onRetry={() => void query.refetch()} testId="sms-settings-error" />;
  }

  const anyDirty = SECTIONS.some((s) => sectionDirty(s, draft, saved));
  const configured = overview.data ? overview.data.configured : null;

  const patch = (change: Partial<SettingsDraft>) => setDraft((d) => (d ? { ...d, ...change } : d));

  const save = async (which: SettingsSectionKey) => {
    setConfirmingMaster(false);
    setSavingSection(which);
    setErrors((e) => ({ ...e, [which]: undefined }));
    setStale(false);
    try {
      const result = await update.mutateAsync(buildInput(draft, which, baseVersion, data));
      setDraft((d) => (d ? withSection(which, d, draftFrom(result)) : draftFrom(result)));
      setBaseVersion(result.version);
      const masterChanged = which === "switches" && result.otpEnabled !== data.otpEnabled;
      toast({
        title: masterChanged ? (result.otpEnabled ? "SMS codes are on" : "SMS codes are off") : SAVED_TITLE[which],
        description:
          result.warnings.length > 0
            ? `Saved, with a warning: ${result.warnings.join(" ")}`
            : "It applies at once, in the apps too: they ask the server before every code.",
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
    if (which === "cost" && validateCost(draft).first !== null) return;
    // switching SMS codes on or off decides what every employee is offered: say so and ask first
    if (which === "switches" && draft.otpEnabled !== saved.otpEnabled) {
      setConfirmingMaster(true);
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

  const turningOn = draft.otpEnabled;

  return (
    <div className="space-y-4" data-testid="sms-settings">
      {data.updatedAt && (
        <p className="text-xs text-muted-foreground" data-testid="sms-settings-updated">
          Last saved {data.updatedBy ? `by ${data.updatedBy} ` : ""}on {formatWhen(data.updatedAt)}.
        </p>
      )}
      {data.warnings.length > 0 && (
        <Notice tone="warn" testId="sms-settings-warnings">
          <p className="font-semibold">The server points out:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <NestedTabs
        base={`${SMS_BASE}/settings`}
        items={SETTINGS_SECTIONS.filter((s) => sections.includes(s.value)).map((s) => ({ ...s }))}
        value={section}
        testId="sms-settings-nested"
        label="Sections of Settings"
      >
        {section === "switches" && <SwitchesSection {...common("switches")} configured={configured} />}
        {section === "limits" && <LimitsSection {...common("limits")} />}
        {section === "cost" && (
          <CostSection
            {...common("cost")}
            month={overview.data ?? null}
            defaultPrice={data.pricePerSmsDefault ?? undefined}
          />
        )}
      </NestedTabs>

      <ConfirmDialog
        open={confirmingMaster}
        title={turningOn ? "Switch SMS codes on?" : "Switch SMS codes off?"}
        confirmLabel={turningOn ? "Yes, switch on" : "Yes, switch off"}
        onConfirm={() => void save("switches")}
        onCancel={() => setConfirmingMaster(false)}
        testId="sms-master-confirm"
      >
        {turningOn ? (
          <>
            <p>
              From the next code on, employees can get one-time codes by SMS from {PROVIDER_NAME}, for the uses switched
              on below. Each SMS costs a little.
            </p>
            {configured === false && (
              <p className="font-semibold text-amber-700 dark:text-amber-400">
                {PROVIDER_NAME} is not set up on the server yet, so the apps will offer no SMS until it is.
              </p>
            )}
            <p>{INDEPENDENT_TEXT}</p>
          </>
        ) : (
          <>
            <p>
              No SMS will be sent from the next code on, and the apps stop offering SMS at once. Codes already sent work
              until they expire.
            </p>
            <p>
              If WhatsApp codes are on (WhatsApp Control), employees keep getting codes there. If they are off too,
              employees sign in with their password. Nobody is locked out.
            </p>
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
