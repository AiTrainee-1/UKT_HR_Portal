import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, FilePlus2, KeyRound, LockKeyhole, MessageSquareText, ShieldCheck, Timer } from "lucide-react";
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
  useWhatsAppOverview,
  useWhatsAppUsage,
  whatsAppErrorMessage,
  type WhatsAppFeature,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip, Notice, Panel, TemplateStatusChip, VALUE_TINT, WhatsAppPreview } from "./kit";
import {
  OTP_TYPES,
  authTemplatePreview,
  findTemplate,
  formatCount,
  monthOf,
  templateNameFor,
  templateState,
  type TemplateState,
  type Tone,
} from "./logic";
import TemplateEditorDialog from "./TemplateEditor";
import { ConfirmDialog } from "./shared";
import type { WaAccess, WaTab } from "./tabs";

const SMS_CONTROL = "/hr/sms-control/overview";

/** The three places a WhatsApp code is used, in the order an employee meets them. */
const PURPOSES: { key: string; title: string; help: string }[] = [
  {
    key: "otpLoginEnabled",
    title: "Sign-in",
    help: "Employees sign in to the mobile app and the Employee Web App with a code.",
  },
  {
    key: "otpResetEnabled",
    title: "Password reset",
    help: "Forgot password asks for a code before a new password is set.",
  },
  {
    key: "otpActivateEnabled",
    title: "New account activation",
    help: "A new employee confirms a code before choosing their first password.",
  },
];

/** OTP: WhatsApp's one-time codes on their own: the WhatsApp OTP master, where codes are used, how long one lasts, the
 *  code template at Meta, this month's codes, and password sign-in. SMS codes are set on SMS Control and work
 *  independently (no SMS data is shown here). */
export default function OtpTab({ access, go }: { access: WaAccess; go: (tab: WaTab) => void }) {
  const { toast } = useToast();
  const canEdit = access.canEdit("otp");
  const { data, isLoading, error } = useWhatsAppControlSettings();
  const overview = useWhatsAppOverview(access.canOpen("overview")).data ?? null;
  const templates = useMetaTemplates(access.canOpen("templates")).data ?? null;
  const usage = useWhatsAppUsage(monthOf(new Date()), access.canOpen("usage")).data ?? null;
  const update = useUpdateWhatsAppControlSettings();
  const [askOff, setAskOff] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expiry, setExpiry] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (!data) {
    return (
      <Notice tone="bad" role="alert" title="The OTP settings could not be loaded" testId="wa-otp-error">
        {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
      </Notice>
    );
  }

  const feature = (key: string): WhatsAppFeature | undefined => data.features.find((f) => f.key === key);
  const expiryTiming = data.timings.find((t) => t.key === "otpExpiryMinutes");
  const expiryText = expiry ?? (expiryTiming ? String(expiryTiming.value) : "");
  const expiryNum = Number(expiryText);
  const expiryValid =
    !!expiryTiming && Number.isInteger(expiryNum) && expiryNum >= expiryTiming.min && expiryNum <= expiryTiming.max;

  const templateName = templateNameFor(
    OTP_TYPES[0],
    data.templateOverrides,
    templates?.templates ?? null,
    data.messageTypes,
  );
  const template = findTemplate(templateName, templates?.templates ?? null);
  const tplState: TemplateState | null = templates
    ? templateState(template?.status ?? null)
    : overview?.otp.templateStatus
      ? templateState(overview.otp.templateStatus)
      : null;
  const purposesOn = PURPOSES.filter((p) => feature(p.key)?.enabled).length;

  // the verdict at the top: OFF, working, or ON but held back (the first reason that applies)
  const held = !data.engineEnabled
    ? "The WhatsApp engine is OFF (Message Controls), so no code goes by WhatsApp."
    : tplState !== null && tplState !== "approved"
      ? `The code template ${templateName ?? ""} is not approved by Meta yet, so no code goes by WhatsApp.`
      : overview && !overview.connection.configured
        ? "WhatsApp is not set up on this server (Settings)."
        : overview && overview.otp.enabled && !overview.otp.available
          ? "WhatsApp codes can't be sent from this server right now."
          : overview && overview.otp.enabled && overview.otp.paused
            ? `On hold: ${overview.otp.pauseReason ?? "WhatsApp codes can't be sent right now."} Password sign-in stays open meanwhile.`
            : purposesOn === 0
              ? "Every use below is OFF."
              : null;
  const verdict: { label: string; tone: Tone } = !data.otpEnabled
    ? { label: "OFF", tone: "neutral" }
    : held
      ? { label: "ON, not available", tone: "warn" }
      : { label: "Working", tone: "good" };

  const save = (body: Record<string, boolean | number>, title: string) =>
    update.mutate(body, {
      onSuccess: () => toast({ title }),
      onError: (e) =>
        toast({
          title: "Couldn't save that",
          description: whatsAppErrorMessage(e, "Try again."),
          variant: "destructive",
        }),
    });

  const setMaster = (next: boolean) => {
    if (!next) return setAskOff(true);
    save({ otpEnabled: true }, "WhatsApp OTP: ON");
  };

  // this month's WhatsApp codes: the server's count, else the sends of the three code types
  const month = overview?.otp.month ?? null;
  const sentFromUsage = usage
    ? usage.byType.filter((t) => OTP_TYPES.includes(t.type)).reduce((n, t) => n + t.messages, 0)
    : null;
  const sent = month?.sent ?? sentFromUsage;
  const preview = authTemplatePreview("482913", expiryTiming?.value ?? null);
  const password = feature("passwordLoginEnabled");

  return (
    <div className="space-y-4" data-testid="wa-otp">
      <section
        className={cn(
          "flex flex-wrap items-center justify-between gap-4 rounded-3xl border p-5 shadow-sm",
          data.otpEnabled ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950" : "bg-card",
        )}
        data-testid="wa-otp-master"
        data-state={data.otpEnabled ? "on" : "off"}
      >
        <div className="flex min-w-0 items-start gap-3.5">
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white",
              data.otpEnabled ? "bg-emerald-600" : "bg-slate-500",
            )}
          >
            <KeyRound size={20} />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-lg font-bold leading-tight">
              WhatsApp sign-in codes
              <Chip tone={verdict.tone} testId="wa-otp-verdict">
                {verdict.label}
              </Chip>
            </p>
            <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
              {data.otpEnabled
                ? (held ?? "Employees can get their one-time code on WhatsApp for every use switched on below.")
                : "No code goes by WhatsApp. Employees use SMS codes where those are on, or their password."}
            </p>
          </div>
        </div>
        <Switch
          checked={data.otpEnabled}
          disabled={!canEdit || update.isPending}
          onCheckedChange={setMaster}
          aria-label="WhatsApp OTP"
          data-testid="wa-otp-master-switch"
        />
      </section>

      <Notice tone="info" icon={MessageSquareText} testId="wa-otp-sms-note">
        SMS codes are switched on and off on{" "}
        <Link href={SMS_CONTROL} className="font-semibold underline underline-offset-2">
          SMS Control
        </Link>{" "}
        and work on their own: either WhatsApp or SMS is enough. When both are on, the employee chooses how to get the
        code, and can ask for it the other way if it doesn't arrive.
      </Notice>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Where WhatsApp codes are used"
          description="Each use can be switched on its own."
          icon={ShieldCheck}
          testId="wa-otp-purposes"
        >
          <div className={cn("divide-y", !data.otpEnabled && "opacity-60")}>
            {PURPOSES.map((p) => {
              const f = feature(p.key);
              if (!f) return null;
              return (
                <div
                  key={p.key}
                  className="flex items-start justify-between gap-4 py-3"
                  data-testid={`wa-otp-purpose-${p.key}`}
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold">{p.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{p.help}</p>
                  </div>
                  <Switch
                    checked={f.enabled}
                    disabled={!canEdit || update.isPending}
                    onCheckedChange={(v) =>
                      save({ [f.key]: v }, `WhatsApp code for ${p.title.toLowerCase()}: ${v ? "ON" : "OFF"}`)
                    }
                    aria-label={`WhatsApp code for ${p.title}`}
                    data-testid={`toggle-${f.key}`}
                  />
                </div>
              );
            })}
          </div>
          {!data.otpEnabled && (
            <p className="mt-2 text-xs text-muted-foreground">These apply once WhatsApp OTP is ON.</p>
          )}
        </Panel>

        <Panel
          title="The code template"
          description="Meta sends codes only with an approved authentication template (a Copy code button, no free text)."
          icon={FilePlus2}
          testId="wa-otp-template"
        >
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs" data-testid="wa-otp-template-name">
              {templateName}
            </code>
            {tplState !== null ? (
              <TemplateStatusChip state={tplState} testId="wa-otp-template-status" />
            ) : (
              <span className="text-xs text-muted-foreground">Status shown on the Templates tab</span>
            )}
            {access.canEdit("templates") &&
              templates?.configured &&
              tplState !== null &&
              tplState !== "approved" &&
              tplState !== "pending" && (
                <Button
                  size="sm"
                  className="ml-auto h-8 gap-1.5 text-xs"
                  onClick={() => setCreating(true)}
                  data-testid="wa-otp-create-template"
                >
                  <FilePlus2 size={13} /> Create template
                </Button>
              )}
          </div>
          {template?.rejectedReason && tplState !== "approved" && (
            <p className="mt-2 text-xs text-red-700 dark:text-red-300">Meta: {template.rejectedReason}</p>
          )}
          <WhatsAppPreview
            body={preview.body}
            footer={preview.footer}
            buttons={["Copy code"]}
            testId="wa-otp-preview"
            className="mt-3 max-w-sm"
          />
          {access.canOpen("templates") && (
            <button
              type="button"
              onClick={() => go("templates")}
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline dark:text-sky-300"
            >
              All templates <ArrowRight size={11} />
            </button>
          )}
        </Panel>

        <Panel
          title="Code expiry"
          icon={Timer}
          testId="wa-otp-expiry"
          description="How long a WhatsApp code works after it is sent."
        >
          {expiryTiming ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wa-otp-expiry-input" className="text-xs">
                  Minutes
                </Label>
                <Input
                  id="wa-otp-expiry-input"
                  type="number"
                  min={expiryTiming.min}
                  max={expiryTiming.max}
                  value={expiryText}
                  disabled={!canEdit}
                  onChange={(e) => setExpiry(e.target.value)}
                  className="w-28"
                  data-testid="wa-otp-expiry-input"
                />
              </div>
              <Button
                size="sm"
                disabled={!canEdit || !expiryValid || expiryNum === expiryTiming.value || update.isPending}
                onClick={() =>
                  update.mutate(
                    { otpExpiryMinutes: expiryNum },
                    {
                      onSuccess: () => {
                        setExpiry(null);
                        toast({ title: `WhatsApp codes now last ${expiryNum} minutes` });
                      },
                      onError: (e) =>
                        toast({
                          title: "Couldn't save the expiry",
                          description: whatsAppErrorMessage(e, "Try again."),
                          variant: "destructive",
                        }),
                    },
                  )
                }
                data-testid="wa-otp-expiry-save"
              >
                Save expiry
              </Button>
              <p className="w-full text-[11px] text-muted-foreground">
                {expiryTiming.min}–{expiryTiming.max} minutes. Meta prints it under the code. SMS codes have their own
                expiry on SMS Control.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The server did not send the expiry.</p>
          )}
        </Panel>

        <Panel title="This month" icon={KeyRound} testId="wa-otp-month" description="WhatsApp codes only.">
          <div className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                ["Sent", sent, "neutral", "wa-otp-sent"],
                ["Delivered", month?.delivered ?? null, "info", "wa-otp-delivered"],
                ["Used to sign in", month?.verified ?? null, "good", "wa-otp-verified"],
              ] as const
            ).map(([label, n, tone, id]) => (
              <div key={label} className="rounded-xl bg-muted px-2 py-3" data-testid={id}>
                <p className={cn("text-xl font-bold tabular-nums", VALUE_TINT[tone])}>
                  {n === null ? "—" : formatCount(n)}
                </p>
                <p className="text-[11px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
          {month === null && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Delivered and used counts appear once the server reports them.
            </p>
          )}
          {overview?.otp.limits && (
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="wa-otp-limits">
              Limits (each WhatsApp code costs money): {formatCount(overview.otp.limits.hourUsed)} of{" "}
              {formatCount(overview.otp.limits.hourlyCap)} this hour, {formatCount(overview.otp.limits.dayUsed)} of{" "}
              {formatCount(overview.otp.limits.dailyCap)} today; at most{" "}
              {formatCount(overview.otp.limits.perEmployeePerDay)} a day per employee and use, and{" "}
              {formatCount(overview.otp.limits.perNumberPerHour)} an hour to one number. A limit used up puts codes on
              hold and keeps password sign-in open.
            </p>
          )}
        </Panel>
      </div>

      {password && (
        <Panel title="Password sign-in" icon={LockKeyhole} testId="wa-otp-password">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 text-[13px]">
              <p>
                Employee code and password sign-in is{" "}
                <b className={password.enabled ? VALUE_TINT.good : VALUE_TINT.warn}>
                  {password.enabled ? "ON" : "OFF"}
                </b>
                .
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Turned off, it is refused only while a code can actually be sent for sign-in, by WhatsApp or SMS. If
                neither can, password sign-in comes back by itself, so nobody is ever locked out.
              </p>
            </div>
            <Switch
              checked={password.enabled}
              disabled={!canEdit || update.isPending}
              onCheckedChange={(v) => save({ passwordLoginEnabled: v }, `Password sign-in: ${v ? "ON" : "OFF"}`)}
              aria-label="Password sign-in"
              data-testid="toggle-passwordLoginEnabled"
            />
          </div>
        </Panel>
      )}

      <TemplateEditorDialog
        open={creating}
        onClose={() => setCreating(false)}
        messageType={OTP_TYPES[0]}
        label="sign-in codes"
      />

      <ConfirmDialog
        open={askOff}
        title="Turn WhatsApp OTP OFF?"
        confirmLabel="Turn OFF"
        destructive
        pending={update.isPending}
        onConfirm={() => {
          setAskOff(false);
          save({ otpEnabled: false }, "WhatsApp OTP: OFF");
        }}
        onCancel={() => setAskOff(false)}
        testId="wa-otp-off-confirm"
      >
        <p>No sign-in, password-reset or activation code will go by WhatsApp.</p>
        <p>
          Employees get their code by SMS where SMS codes are switched on (SMS Control), or sign in with their password.
          Nobody is locked out.
        </p>
      </ConfirmDialog>
    </div>
  );
}
