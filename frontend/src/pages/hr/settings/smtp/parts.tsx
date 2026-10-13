import { AlertTriangle, CircleCheck, Paperclip } from "lucide-react";
import { PreviewCard, PreviewLine } from "../kit/SettingBlock";
import {
  connectionSecurity,
  fromLine,
  gmailMayRewriteFrom,
  listWords,
  missingPieces,
  providerLabel,
  type MailGate,
  type SmtpForm,
} from "./preview";

/** One line under a box: the problem that stops a save (red), else advice (amber), else a hint. */
export function InputNote({
  id,
  error,
  warning,
  hint,
}: {
  id?: string;
  error?: string;
  warning?: string;
  hint?: string;
}) {
  if (error) {
    return (
      <p id={id} role="alert" className="text-xs font-medium text-red-600">
        {error}
      </p>
    );
  }
  if (warning) {
    return (
      <p id={id} className="flex items-start gap-1 text-xs text-amber-700">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {warning}
      </p>
    );
  }
  return hint ? (
    <p id={id} className="text-xs leading-snug text-gray-500">
      {hint}
    </p>
  ) : null;
}

/**
 * "Ready to send?": the values on screen read the way the mail service reads them, before anything is saved. Says what
 * is still missing (every email is refused until host, username and App Password are all there) and, when this role
 * can see Gmail Control, the two switches outside this tab that also decide whether mail goes out.
 */
export function ReadinessCard({
  form,
  passwordSaved,
  gate,
}: {
  form: SmtpForm;
  passwordSaved: boolean;
  gate: MailGate;
}) {
  const missing = missingPieces(form, passwordSaved);
  const port = Number(form.port.trim());
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65535;
  const host = form.host.trim();
  const user = form.username.trim();
  const from = fromLine(form.fromName, form.fromEmail, form.username);
  return (
    <PreviewCard
      title="Ready to send?"
      scenario="Worked out from the values on screen, before you save. Every email (salary slip, letter, ID card, visitor or recruitment mail) goes out this way."
      testId="smtp-readiness"
    >
      <PreviewLine
        label="Connects to"
        result={
          host
            ? `${host}${portOk ? `:${port} (${connectionSecurity(port).label})` : " - port not valid"}`
            : "no mail server"
        }
        tone={host && portOk ? "neutral" : "bad"}
      />
      <PreviewLine label="Signs in as" result={user || "no username"} tone={user ? "neutral" : "bad"} />
      <PreviewLine
        label="App Password"
        result={
          form.password ? "new one typed (replaces the saved one)" : passwordSaved ? "saved (hidden)" : "none saved"
        }
        tone={form.password || passwordSaved ? "neutral" : "bad"}
      />
      <PreviewLine label="Sends as" result={from.address ? from.header : "no sender address"} />
      {missing.length > 0 ? (
        <PreviewLine
          label="Result"
          result={`every email is refused until the ${listWords(missing)} ${missing.length > 1 ? "are" : "is"} saved`}
          tone="bad"
          testId="smtp-readiness-result"
        />
      ) : (
        <PreviewLine
          label="Result"
          result={`complete - Gmail Control shows "${providerLabel(host)}"`}
          tone="good"
          testId="smtp-readiness-result"
        />
      )}
      {gate && !gate.sendingAllowedHere && (
        <PreviewLine
          label="This server"
          result="a development setup: it never sends email, whatever is saved here"
          tone="warn"
        />
      )}
      {gate && gate.emailsEnabled === false && (
        <PreviewLine label='Gmail Control "Send emails"' result="switched off: nothing is emailed" tone="warn" />
      )}
    </PreviewCard>
  );
}

/**
 * A small drawing of how an employee's inbox shows an email sent with these values: the sender's name and address
 * (From Name, From Email or else the Username) and, inside the email, the banner with the company name, which comes
 * from Settings > Company, not from this tab.
 */
export function SenderPreview({ form, companyName }: { form: SmtpForm; companyName: string }) {
  const from = fromLine(form.fromName, form.fromEmail, form.username);
  const rewritten = gmailMayRewriteFrom(form);
  const shownName = from.name || from.address || "(no sender)";
  return (
    <PreviewCard
      title="How the email arrives"
      scenario="Asha Kumar's August 2026 salary slip, sent with the values on screen."
      testId="smtp-sender-preview"
    >
      <div className="settings-glass overflow-hidden rounded-xl text-[12px]">
        <div className="flex items-start gap-2.5 border-b border-slate-100 px-3 py-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-black text-white">
            {shownName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate">
              <span className="font-bold text-gray-900" data-testid="smtp-preview-name">
                {shownName}
              </span>{" "}
              {from.name && from.address && <span className="text-gray-500">&lt;{from.address}&gt;</span>}
            </p>
            <p className="truncate font-semibold text-gray-700">Salary Slip - August 2026 | {companyName}</p>
            <p className="flex items-center gap-1 text-gray-400">
              <Paperclip size={11} /> Salary slip (PDF)
            </p>
          </div>
        </div>
        <div className="bg-[#0E4B3A] px-3 py-2 text-center">
          <p className="text-[11px] font-black tracking-wide text-white">{companyName.toUpperCase()}</p>
          <p className="text-[10px] text-white/80">Salary Slip - August 2026</p>
        </div>
      </div>
      <p className="break-all font-mono text-[11px] text-gray-600" data-testid="smtp-preview-header">
        From: {from.header || "(no sender address)"}
      </p>
      {from.encoded && (
        <p className="text-[11px] text-gray-500">
          The name has letters outside plain English, so it travels encoded; inboxes show it as typed.
        </p>
      )}
      {rewritten && (
        <p className="flex items-start gap-1 text-[11px] text-amber-700">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> Gmail shows {form.username.trim()} instead of{" "}
          {form.fromEmail.trim()} unless that address is added under Gmail Settings &gt; Accounts &gt; "Send mail as".
        </p>
      )}
      {!rewritten && from.address && (
        <p className="flex items-center gap-1 text-[11px] text-emerald-700">
          <CircleCheck size={11} /> Replies go to {from.address}.
        </p>
      )}
    </PreviewCard>
  );
}
