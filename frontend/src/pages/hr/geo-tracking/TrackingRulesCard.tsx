// Tracking Settings -> "Geo-tracking rules": the rules the tracking engine follows for every On-Duty journey (what counts as a
// stop or a gap, how the phone samples and uploads, how long raw positions are kept, when the day ends, one or two punch
// photos, the notice employees accept, and whether stop addresses are looked up). One row on the server; a save sends only what
// changed. A role with View only sees the rules but cannot change them.
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Camera,
  ChevronDown,
  Info,
  MapPin,
  Power,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Timer,
  Wrench,
} from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { canEdit, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  isTrackingForbidden,
  trackingErrorMessage,
  useGeoTrackingSettings,
  useUpdateGeoTrackingSettings,
  type GeoReverseProvider,
} from "@/lib/api-client/custom-hooks";
import { Field, ToggleField } from "@/pages/hr/settings/kit/Field";
import { SaveBar } from "@/pages/hr/settings/kit/SaveBar";
import { fmtDateTime } from "./logic";
import {
  NOTICE_MAX_CHARS,
  SPEC,
  needsPhotoConfirm,
  noticeChanged,
  sameForm,
  toForm,
  toPatch,
  validate,
  type NumberKey,
  type RulesForm,
} from "./rules";

const ADVANCED_KEYS: NumberKey[] = ["stopAccuracyFactor", "mergeStopGapSeconds", "distanceFilterM"];

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One group of rules: what it is on the left (an icon, a title, one line), the controls on the right. */
function Section({
  title,
  intro,
  icon: Icon,
  children,
  testId,
}: {
  title: string;
  intro?: ReactNode;
  icon?: IconType;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="grid gap-x-8 gap-y-3 border-t border-slate-100 pt-5 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
      data-testid={testId}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 rounded-lg bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
            <Icon size={14} />
          </span>
        )}
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-gray-900">{title}</h4>
          {intro && <p className="mt-0.5 text-xs leading-snug text-gray-500">{intro}</p>}
        </div>
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

export default function TrackingRulesCard() {
  const { toast } = useToast();
  const { user } = useAuth();
  // the rules are Settings -> Attendance for the API (tracking/settings), and company-wide: a login that belongs to one branch
  // may read them but not change them
  const branchLogin = user?.role === "hr" && !user.isSuperAdmin && !user.isMd && user.branchId != null;
  const editable = canEdit(user, "settings.attendance") && !branchLogin;
  const query = useGeoTrackingSettings();
  const update = useUpdateGeoTrackingSettings();
  const saved = query.data;

  const [form, setForm] = useState<RulesForm | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmPhotos, setConfirmPhotos] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const baseline = useRef<RulesForm | null>(null);

  // the form follows the server until the person starts editing; edits are never overwritten by a refresh
  useEffect(() => {
    if (!saved) return;
    const next = toForm(saved);
    setForm((current) =>
      current === null || (baseline.current && sameForm(current, baseline.current)) ? next : current,
    );
    baseline.current = next;
  }, [saved]);

  if (query.isPending) {
    return (
      <Card className="rounded-2xl" data-testid="rules-loading">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-40 rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (!saved || !form) {
    return (
      <Card className="rounded-2xl" data-testid="rules-error">
        <CardContent className="space-y-3 p-5 text-sm">
          <h3 className="text-base font-bold text-gray-900">Geo-tracking rules</h3>
          <p className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {isTrackingForbidden(query.error)
              ? "You are not allowed to see the tracking rules."
              : trackingErrorMessage(query.error, "The tracking rules could not be loaded.")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const errors = validate(form, saved);
  const hasErrors = Object.keys(errors).length > 0;
  // a problem inside the folded part is shown by opening it
  const advancedError = ADVANCED_KEYS.some((key) => errors[key]);
  const dirty = !sameForm(form, toForm(saved));
  const disabled = !editable;
  const textChanged = noticeChanged(form, saved);

  const set = <K extends keyof RulesForm>(key: K, value: RulesForm[K]) => {
    setServerError(null);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const number = (key: NumberKey, id: string) => {
    const spec = SPEC[key];
    return (
      <Field key={key} label={spec.label} htmlFor={id} unit={spec.unit} hint={spec.hint} error={errors[key]}>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step={spec.integer ? 1 : "any"}
          min={spec.min}
          max={spec.max}
          value={form[key]}
          disabled={disabled}
          aria-invalid={errors[key] ? true : undefined}
          onChange={(e) => set(key, e.target.value)}
          className="h-9 text-sm"
        />
      </Field>
    );
  };

  const save = async () => {
    if (hasErrors || !dirty) return;
    setServerError(null);
    try {
      const answer = await update.mutateAsync(toPatch(form, saved));
      const next = toForm(answer);
      baseline.current = next;
      setForm(next);
      toast({ title: "Tracking rules saved", description: "New journeys and the next rebuild use these rules." });
    } catch (err) {
      setServerError(trackingErrorMessage(err, "The rules could not be saved."));
    }
  };

  const geocoder: { value: GeoReverseProvider; label: string }[] = [
    { value: "off", label: "Off (coordinates only)" },
    { value: "nominatim", label: "OpenStreetMap Nominatim (public service)" },
  ];

  return (
    <Card className="rounded-2xl" data-testid="rules-card" id="geo-rules">
      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 rounded-xl bg-slate-50 p-2 text-slate-600 ring-1 ring-slate-100">
              <SlidersHorizontal size={16} />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-gray-900">Geo-tracking rules</h3>
              <p className="mt-0.5 max-w-3xl text-xs leading-snug text-gray-600">
                How On-Duty journeys are recorded and read. These rules apply to every employee. Changing them never
                edits a journey that is already recorded; use Rebuild on a journey to apply new rules to it.
              </p>
            </div>
          </div>
          {saved.updatedAt && (
            <p
              className="rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-gray-500 ring-1 ring-slate-100"
              data-testid="rules-updated"
            >
              Last saved {fmtDateTime(saved.updatedAt)}
              {saved.updatedBy ? ` by ${saved.updatedBy}` : ""}
            </p>
          )}
        </div>

        {!editable && (
          <p
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-gray-700"
            data-testid="rules-view-only"
          >
            <Info size={13} />
            {branchLogin
              ? "View only: the rules apply to the whole company, so a branch login can read them but not change them."
              : "View only: you can read the rules but not change them."}
          </p>
        )}
        {serverError && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            data-testid="rules-server-error"
          >
            {serverError}
          </p>
        )}

        <Section title="Tracking" icon={Power} testId="rules-tracking">
          <ToggleField
            id="geo-enabled"
            checked={form.enabled}
            onChange={(v) => set("enabled", v)}
            onLabel="Geo-tracking is on"
            offLabel="Geo-tracking is off"
            disabled={disabled}
          >
            When it is off, no new On-Duty request starts a track. Tracks already running continue until they end.
          </ToggleField>
        </Section>

        <Section
          title="Stops and gaps"
          intro="How a journey is split into travel, stationary periods and gaps."
          icon={Timer}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {number("stopMinutes", "rule-stop-minutes")}
            {number("stopRadiusM", "rule-stop-radius")}
            {number("gapMinutes", "rule-gap-minutes")}
            {number("signalLostMinutes", "rule-signal-lost")}
            {number("maxAccuracyM", "rule-max-accuracy")}
            {number("maxSpeedKmh", "rule-max-speed")}
          </div>
        </Section>

        <Section
          title="The employee's phone"
          intro="How the app records and sends positions. The app reads these when it starts and after every upload."
          icon={Smartphone}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {number("sampleMovingSeconds", "rule-sample-moving")}
            {number("sampleStillSeconds", "rule-sample-still")}
            {number("uploadBatchPoints", "rule-upload-batch")}
            {number("uploadIntervalSeconds", "rule-upload-interval")}
          </div>
        </Section>

        <Section title="Day end and keeping data" icon={CalendarClock}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field
              label="Day end (India time)"
              htmlFor="rule-day-end"
              hint="Open On-Duty sessions and their tracks close automatically at this time. Default 23:50."
              error={errors.dayEndTime}
            >
              <Input
                id="rule-day-end"
                type="time"
                value={form.dayEndTime}
                disabled={disabled}
                aria-invalid={errors.dayEndTime ? true : undefined}
                onChange={(e) => set("dayEndTime", e.target.value)}
                className="h-9 text-sm"
              />
            </Field>
            {number("retentionDays", "rule-retention")}
          </div>
        </Section>

        <Section
          title="On-Duty punch photos"
          intro="How many photos an employee takes at each On-Duty punch (the 4 geo punches of the day)."
          icon={Camera}
          testId="rules-photos"
        >
          <fieldset className="grid gap-2 sm:grid-cols-2" disabled={disabled}>
            <legend className="sr-only">Photos per On-Duty punch</legend>
            {(["1", "2"] as const).map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-start gap-2.5 rounded-xl border bg-white p-3 text-sm transition-colors has-[:checked]:border-sky-300 has-[:checked]:bg-sky-50/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70"
                htmlFor={`rule-photos-${v}`}
              >
                <input
                  id={`rule-photos-${v}`}
                  type="radio"
                  name="onduty-photos"
                  value={v}
                  checked={form.ondutyPunchPhotos === v}
                  disabled={disabled}
                  onChange={() => set("ondutyPunchPhotos", v)}
                  className="mt-1"
                />
                <span>
                  <b>{v === "1" ? "1 photo" : "2 photos"}</b>
                  <span className="block text-xs text-gray-600">
                    {v === "1"
                      ? "Every app version works. Use this until everybody has the new app."
                      : "A second photo is required at every punch (Photo 1 and Photo 2)."}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p
            className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900 ring-1 ring-amber-200"
            data-testid="photos-rollout-note"
          >
            <Camera size={14} className="mt-0.5 shrink-0" />
            <span>
              Switch to 2 only after everybody has the new app. An employee whose app can take only one photo cannot
              punch while this is set to 2 (the server asks them to update the app).
            </span>
          </p>
        </Section>

        <Section
          title="Tracking notice"
          intro="Shown to the employee before their first tracked journey. They must accept it; HR can see that they did."
          icon={ScrollText}
          testId="rules-notice"
        >
          <Field
            label="Notice text"
            htmlFor="rule-notice-text"
            hint="Say what is recorded (route, stops, battery, network), when (only while an On-Duty request is open), and who sees it."
            error={errors.noticeText}
          >
            <Textarea
              id="rule-notice-text"
              rows={6}
              value={form.noticeText}
              disabled={disabled}
              aria-invalid={errors.noticeText ? true : undefined}
              maxLength={NOTICE_MAX_CHARS + 200}
              onChange={(e) => set("noticeText", e.target.value)}
            />
          </Field>
          <p className="text-xs text-gray-700" data-testid="notice-version">
            Notice version <b>{saved.noticeVersion}</b>. Employees who accepted an older version are asked again.
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-sm" htmlFor="rule-reaccept">
            <input
              id="rule-reaccept"
              type="checkbox"
              checked={form.reaccept || textChanged}
              disabled={disabled || textChanged}
              onChange={(e) => set("reaccept", e.target.checked)}
              className="mt-1"
            />
            <span>
              Ask everybody to accept the notice again
              <span className="block text-xs text-gray-600" data-testid="notice-bump">
                {textChanged
                  ? `You changed the text, so the version becomes ${saved.noticeVersion + 1} when you save.`
                  : `The version becomes ${saved.noticeVersion + 1} when you save. Tick this after a change in what is recorded that the text does not show.`}
              </span>
            </span>
          </label>
        </Section>

        <Section title="Addresses of stops" icon={MapPin} testId="rules-geocoder">
          <Field label="Look up addresses" htmlFor="rule-geocoder" error={errors.reverseGeocodeProvider}>
            <select
              id="rule-geocoder"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={form.reverseGeocodeProvider}
              disabled={disabled}
              onChange={(e) => set("reverseGeocodeProvider", e.target.value as GeoReverseProvider)}
            >
              {geocoder.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
          <p
            className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-snug ring-1 ${
              form.reverseGeocodeProvider === "nominatim"
                ? "bg-amber-50 text-amber-900 ring-amber-200"
                : "bg-gray-50 text-gray-700 ring-gray-200"
            }`}
            data-testid="geocoder-privacy"
          >
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            <span>
              {form.reverseGeocodeProvider === "nominatim"
                ? "Privacy: the coordinates of every stop are sent to a public service (nominatim.openstreetmap.org, run by the OpenStreetMap Foundation) to get an address. Nothing else is sent, at most one stop per second. Turn it off if coordinates must not leave this server."
                : "Off keeps every coordinate on this server: stops show their coordinates. Turning it on sends the coordinates of each stop to a public service (Nominatim) to get an address."}
            </span>
          </p>
        </Section>

        <details
          className="group rounded-xl border bg-slate-50/50 px-4 py-3"
          data-testid="rules-advanced"
          open={advancedOpen || advancedError}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-gray-800 [&::-webkit-details-marker]:hidden">
            <Wrench size={14} className="text-slate-500" />
            Advanced
            <span className="text-xs font-normal text-gray-500">three rules most people never change</span>
            <ChevronDown size={14} className="ml-auto text-gray-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {number("stopAccuracyFactor", "rule-stop-factor")}
            {number("mergeStopGapSeconds", "rule-merge-gap")}
            {number("distanceFilterM", "rule-distance-filter")}
          </div>
        </details>

        {editable && (
          <div className="sticky bottom-3 z-10 rounded-xl border bg-white p-1.5" data-testid="rules-footer">
            <SaveBar
              dirty={dirty}
              saving={update.isPending}
              onSave={() => (needsPhotoConfirm(form, saved) ? setConfirmPhotos(true) : void save())}
              onDiscard={() => {
                setServerError(null);
                setForm(toForm(saved));
              }}
              saveLabel="Save tracking rules"
              disabled={!dirty || hasErrors}
              hint={hasErrors ? "Fix the highlighted fields first." : undefined}
            />
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmPhotos} onOpenChange={setConfirmPhotos}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Require 2 photos at every On-Duty punch?</AlertDialogTitle>
            <AlertDialogDescription>
              Employees who still have the old app will not be able to punch until they update it. Only continue if
              everybody has the new app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep 1 photo</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPhotos(false);
                void save();
              }}
            >
              Require 2 photos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
