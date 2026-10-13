import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, KeyRound, Mail, Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import { customFetch } from "@/lib/api-client/custom-fetch";
import {
  getPayrollSettingsQueryKey,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type GmailControlSettings,
} from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { SaveBar } from "./kit/SaveBar";
import { settingsAddress } from "./kit/jump";
import { InputNote, ReadinessCard, SenderPreview } from "./smtp/parts";
import {
  changedFields,
  connectionSecurity,
  formFromSaved,
  fromLine,
  isGmailHost,
  maskLogin,
  missingPieces,
  portProblem,
  providerLabel,
  saveOutcome,
  serverMessage,
  smtpErrors,
  smtpPayload,
  smtpWarnings,
  type MailGate,
  type SmtpField,
  type SmtpForm,
} from "./smtp/preview";

const GMAIL_CONTROL = "/hr/gmail-control";
const same = (a: SmtpForm, b: SmtpForm) => changedFields(a, b).length === 0 && a.password === b.password;

/**
 * Settings -> SMTP / Email: the one mailbox login every email of the portal goes out through. Only the login lives
 * here; the test email, the on/off switches, the wording and the daily limit are on Gmail Control.
 */
export default function SmtpTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data, isLoading } = usePayrollSettings();
  const update = useUpdatePayrollSettings();

  // Gmail Control's own status says whether mail can leave this server at all. Optional: a role without Gmail Control
  // cannot read it, and the page then says less rather than guessing.
  const canOpenGmailControl = permissionLevel(user, "gmail_control") !== "hidden";
  const { data: gmail } = useQuery<GmailControlSettings>({
    queryKey: ["/api/gmail-control/settings"],
    queryFn: () => customFetch<GmailControlSettings>("/api/gmail-control/settings"),
    enabled: Boolean(user) && canOpenGmailControl,
    retry: false,
  });
  const gate: MailGate = gmail
    ? {
        sendingAllowedHere: gmail.config.sendingAllowedHere,
        emailsEnabled: gmail.features.find((f) => f.key === "emailsEnabled")?.enabled ?? null,
      }
    : null;

  const saved = useMemo(() => formFromSaved(data), [data]);
  const [form, setForm] = useState<SmtpForm>(saved);
  // Follow the server (a save on another tab refetches these settings) unless something here is being edited.
  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setForm((current) => (same(current, previous) ? saved : current));
  }, [saved]);

  const passwordSaved = Boolean(data?.smtpPasswordSet);
  const branchLogin = data?.companyWideRulesEditable === false;
  const errors = smtpErrors(saved, form);
  const warnings = smtpWarnings(form);
  const dirty = changedFields(saved, form).length > 0;
  const invalid = Object.keys(errors).length > 0;
  const companyName = data?.companyName || data?.slipCompanyName || "UKTextiles";

  const set = (field: SmtpField) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const save = async () => {
    if (!dirty || invalid) return;
    try {
      const result = await update.mutateAsync(smtpPayload(saved, form));
      queryClient.setQueryData(getPayrollSettingsQueryKey(), result);
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/gmail-control") });
      const next = formFromSaved(result);
      lastSaved.current = next;
      setForm(next);
      toast({
        title: "SMTP settings saved",
        description: saveOutcome({ branchLogin, gate, missing: missingPieces(next, Boolean(result.smtpPasswordSet)) }),
      });
    } catch (e) {
      toast({ title: "Failed to save SMTP settings", description: serverMessage(e), variant: "destructive" });
    }
  };

  if (isLoading && !data) {
    return <Skeleton className="h-96 w-full rounded-2xl" data-testid="smtp-loading" />;
  }

  const port = Number(form.port.trim());
  const portValid = !portProblem(form.port);
  const gmailHost = isGmailHost(form.host);

  return (
    <div className="space-y-4">
      {branchLogin && (
        <div
          className="settings-glass flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[13px] leading-snug text-amber-900 !bg-amber-50/70"
          data-testid="smtp-branch-notice"
        >
          <Building2 size={15} className="mt-0.5 shrink-0" />
          <span>
            <b>You are signed in to a branch.</b> What you save here becomes your branch's own mail account, shared by
            every login of this branch: emails sent from these logins (salary slips, letters, ID cards, the test email)
            and visitor emails for this branch's employees use it. Resume-screening emails, and emails sent by an
            administrator, keep using the company account.
          </span>
        </div>
      )}

      <SettingsSection
        icon={Mail}
        title="SMTP / Email Configuration"
        purpose="The mailbox the portal signs in to whenever it sends an email. Every kind of email goes out through it; nothing else on the portal sends mail."
        usedBy={[
          { label: "Gmail Control", to: GMAIL_CONTROL },
          { label: "Salary slips", to: "/hr/payroll" },
          { label: "Letters", to: "/hr/recruitment/documents" },
          { label: "ID cards", to: "/hr/id-cards" },
          { label: "Visitor arrival" },
          { label: "Resume screening", to: "/hr/recruitment/resume-screening" },
        ]}
        testId="smtp-section"
        footer={
          <SaveBar
            dirty={dirty}
            saving={update.isPending}
            onSave={save}
            onDiscard={() => setForm(saved)}
            saveLabel="Save SMTP Settings"
            disabled={readOnly || !dirty || invalid}
            hint={invalid ? "Fix the highlighted fields first." : undefined}
          />
        }
      >
        <div className="pb-4">
          <ReadinessCard form={form} passwordSaved={passwordSaved} gate={gate} />
        </div>

        <SettingBlock
          id="smtp-host"
          labelFor="smtp-host-input"
          title="SMTP Host"
          purpose="The address of the mail server the portal signs in to whenever it sends an email. For a Gmail mailbox it is smtp.gmail.com."
          affects={[
            {
              where: "Every email the portal sends",
              what: "connects to this server: salary slips (one or in bulk), offer and resignation letters, ID cards, visitor arrival notices, rejection and interview emails, and the test email",
            },
            {
              where: "Gmail Control",
              to: GMAIL_CONTROL,
              what: 'shows the provider as "Gmail (SMTP)" when the host contains gmail, otherwise "SMTP mail server"; only for Gmail does a failed sign-in add the App Password hint',
            },
          ]}
          defaultText="smtp.gmail.com"
          note="A wrong host makes every email fail (each one can wait up to 15 seconds first); the failures are listed on Gmail Control > Messages. A change applies to the next email; nothing already sent changes."
          preview={
            <PreviewCard title="Example" scenario="What Gmail Control shows for the host on screen.">
              <PreviewLine label="Provider" result={form.host.trim() ? providerLabel(form.host) : "-"} />
              <PreviewLine
                label="A wrong App Password reports"
                result={gmailHost ? "authentication failed + how to make an App Password" : "authentication failed"}
              />
            </PreviewCard>
          }
        >
          <Input
            id="smtp-host-input"
            value={form.host}
            onChange={set("host")}
            placeholder="smtp.gmail.com"
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
            aria-invalid={Boolean(errors.host)}
            aria-describedby="smtp-host-note"
          />
          <InputNote id="smtp-host-note" error={errors.host} hint="Just the server name: no https:// and no :port." />
        </SettingBlock>

        <SettingBlock
          id="smtp-port"
          labelFor="smtp-port-input"
          title="SMTP Port"
          purpose="Which door on the mail server the portal uses. 587 starts plain and switches to encryption before signing in (STARTTLS); 465 is encrypted from the first byte (SSL)."
          affects={[
            {
              where: "Every email",
              what: "port 465 is sent over SSL, any other port over STARTTLS; the password is never sent unencrypted",
            },
            { where: "Gmail Control > Configuration", to: GMAIL_CONTROL, what: "shows the port and its security" },
          ]}
          defaultText="587"
          note="Gmail accepts only 587 and 465. A port the server does not answer on makes every email fail."
          preview={
            <PreviewCard title="Example" scenario="How the portal connects with the port on screen.">
              <PreviewLine
                label={`Port ${form.port.trim() || "(blank)"}`}
                result={
                  portValid
                    ? `${connectionSecurity(port).label} - ${connectionSecurity(port).explain}`
                    : "not a valid port: cannot be saved"
                }
                tone={portValid ? "info" : "bad"}
              />
            </PreviewCard>
          }
        >
          <Input
            id="smtp-port-input"
            value={form.port}
            onChange={set("port")}
            inputMode="numeric"
            placeholder="587"
            className="w-32"
            disabled={readOnly}
            aria-invalid={Boolean(errors.port)}
            aria-describedby="smtp-port-note"
          />
          <InputNote id="smtp-port-note" error={errors.port} warning={warnings.port} />
        </SettingBlock>

        <SettingBlock
          id="smtp-username"
          labelFor="smtp-username-input"
          title="Username"
          purpose="The login name of the mailbox the portal signs in with. For Gmail it is the full Gmail address."
          affects={[
            { where: "Every email", what: "the portal signs in to the mail server with this name" },
            { where: "The sender address", what: "used as the From address when From Email is left blank" },
            { where: "Gmail Control", to: GMAIL_CONTROL, what: "shows it partly hidden" },
          ]}
          defaultText="None - no email can be sent until it is saved"
          note="Changing it to another mailbox changes who every future email comes from; emails already sent are not affected."
          preview={
            form.username.trim() ? (
              <PreviewCard title="Example" scenario="How Gmail Control shows the username on screen.">
                <PreviewLine label="Signed in as" result={maskLogin(form.username.trim())} />
              </PreviewCard>
            ) : undefined
          }
        >
          <Input
            id="smtp-username-input"
            value={form.username}
            onChange={set("username")}
            placeholder="hr.uktex@gmail.com"
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
            aria-invalid={Boolean(errors.username)}
            aria-describedby="smtp-username-note"
          />
          <InputNote id="smtp-username-note" error={errors.username} warning={warnings.username} />
        </SettingBlock>

        <SettingBlock
          id="smtp-password"
          labelFor="smtp-password-input"
          title="App Password"
          purpose="The 16-letter Google App Password (not the Gmail account's own password) that lets the portal send through that account. Once saved it is never shown again and never sent to any page."
          affects={[
            {
              where: "Every email",
              what: 'the portal signs in with it; a wrong or cancelled one makes every email fail with "SMTP authentication failed"',
            },
            { where: "Gmail Control", to: GMAIL_CONTROL, what: "shows only whether one is saved" },
          ]}
          note={
            <>
              Google cancels App Passwords when the Gmail account's own password is changed: make a new one and save it
              here. To make one: Google Account &gt; Security &gt; 2-Step Verification (it must be on) &gt; App
              passwords.
            </>
          }
        >
          <p
            className={`flex items-center gap-1.5 text-xs font-semibold ${passwordSaved ? "text-emerald-700" : "text-red-700"}`}
            data-testid="smtp-password-status"
          >
            <KeyRound size={13} />
            {passwordSaved
              ? "Password saved - type a new one to replace it"
              : "No App Password saved - every email is refused until one is saved"}
          </p>
          <Input
            id="smtp-password-input"
            type="password"
            value={form.password}
            onChange={set("password")}
            placeholder={passwordSaved ? "Leave blank to keep the saved password" : "xxxx xxxx xxxx xxxx"}
            autoComplete="new-password"
            disabled={readOnly}
            aria-describedby="smtp-password-note"
          />
          <InputNote
            id="smtp-password-note"
            warning={warnings.password}
            hint={form.password ? "The new password replaces the saved one when you save." : undefined}
          />
        </SettingBlock>

        <SettingBlock
          id="smtp-from-email"
          labelFor="smtp-from-email-input"
          title="From Email"
          purpose="The sender address employees see on every email. Leave it blank to send from the Username."
          affects={[
            { where: "Every email", what: "the From line and the return address use it" },
            { where: "Gmail Control", to: GMAIL_CONTROL, what: 'shows it as "Sent from"' },
            {
              where: "Gmail itself",
              what: 'replaces an address that is not the signed-in account or one of its verified "Send mail as" addresses with the account\'s own address',
            },
          ]}
          defaultText="Blank (the Username is used)"
          preview={
            <PreviewCard
              title="Example"
              scenario="The sender address the next email carries, from the boxes on screen."
            >
              <PreviewLine
                label="Sender address"
                result={fromLine("", form.fromEmail, form.username).address || "none yet"}
                tone={fromLine("", form.fromEmail, form.username).address ? "neutral" : "bad"}
              />
              <PreviewLine
                label="Taken from"
                result={form.fromEmail.trim() ? "From Email" : "Username (From Email is blank)"}
              />
            </PreviewCard>
          }
          note={
            <>
              Not the same as the company email printed on letters and reports (
              <Link href={settingsAddress("company")} className="font-semibold underline">
                Settings &gt; Company
              </Link>
              ) or the HR email shown in the employee apps (
              <Link href={settingsAddress("hr_contact")} className="font-semibold underline">
                Settings &gt; HR Contact
              </Link>
              ). Only this one decides who emails come from.
            </>
          }
        >
          <Input
            id="smtp-from-email-input"
            value={form.fromEmail}
            onChange={set("fromEmail")}
            placeholder={form.username.trim() || "hr@uktextiles.in"}
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
            aria-invalid={Boolean(errors.fromEmail)}
            aria-describedby="smtp-from-email-note"
          />
          <InputNote
            id="smtp-from-email-note"
            error={errors.fromEmail}
            hint={form.fromEmail.trim() ? undefined : "Blank: emails come from the Username."}
          />
        </SettingBlock>

        <SettingBlock
          id="smtp-from-name"
          labelFor="smtp-from-name-input"
          title="From Name"
          purpose="The name shown next to the sender address in the inbox, such as UKTextiles HR."
          affects={[
            { where: "Every email", what: "the From line shows this name; blank shows the bare address" },
            { where: "Gmail Control", to: GMAIL_CONTROL, what: 'shows it in "Sent from"' },
          ]}
          defaultText="UKTextiles HR"
          note="The coloured banner inside each email shows the company name from Settings > Company, not this name."
          preview={<SenderPreview form={form} companyName={companyName} />}
        >
          <Input
            id="smtp-from-name-input"
            value={form.fromName}
            onChange={set("fromName")}
            placeholder="UKTextiles HR"
            autoComplete="off"
            disabled={readOnly}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={Send}
        title="Testing and switching email"
        purpose="Everything about the emails themselves lives on Gmail Control, next to the record of every email sent."
      >
        <SettingBlock
          id="smtp-gmail-control"
          title="Test email, on/off switches, wording and daily limit"
          purpose="Send a test email through the account above, see whether this server may send, switch all email or one kind of email off, change the subject and wording of each email, and cap how many go out a day."
          affects={[
            {
              where: "Gmail Control",
              to: GMAIL_CONTROL,
              what: "an email goes out only when its master, module and email switches are on, the account above is complete, this server is allowed to send and the daily limit is not reached",
            },
          ]}
        >
          <ManagedElsewhere
            title="Managed on Gmail Control"
            to={GMAIL_CONTROL}
            linkLabel="Open Gmail Control"
            testId="smtp-managed-elsewhere"
          >
            Configuration tab: test email and status. Feature Controls: the switches and the daily limit. Message Text:
            the wording.
            {!canOpenGmailControl && " Your role cannot open Gmail Control; ask an administrator."}
          </ManagedElsewhere>
        </SettingBlock>
      </SettingsSection>
    </div>
  );
}
