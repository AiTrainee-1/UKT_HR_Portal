import { ApiError } from "@/lib/api-client/custom-fetch";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";

/**
 * The SMTP / Email tab's rules, mirrored from the server so the page can explain a value before it is saved:
 * backend/api/payroll_views.py `_smtp_problem` (what a save may contain), backend/api/email_service.py (`_deliver`,
 * `_build_message`, `smtp_missing_reason`) and backend/api/email_control_views.py `_config` (what Gmail Control shows).
 */

/** The six boxes as typed. `password` is a NEW App Password being typed: empty means "keep the saved one". */
export type SmtpForm = {
  host: string;
  port: string;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
};

export type SmtpField = keyof SmtpForm;

type SavedSmtp = Pick<
  PayrollSettingsItem,
  "smtpHost" | "smtpPort" | "smtpUsername" | "smtpFromEmail" | "smtpFromName" | "smtpPasswordSet"
>;

/** What is saved, as the boxes show it. Blank stays blank: the old page showed made-up defaults for blank values. */
export function formFromSaved(saved: Partial<SavedSmtp> | undefined | null): SmtpForm {
  return {
    host: saved?.smtpHost ?? "",
    port: saved?.smtpPort === undefined || saved?.smtpPort === null ? "" : String(saved.smtpPort),
    username: saved?.smtpUsername ?? "",
    password: "",
    fromEmail: saved?.smtpFromEmail ?? "",
    fromName: saved?.smtpFromName ?? "",
  };
}

export const SMTP_FIELDS: SmtpField[] = ["host", "port", "username", "password", "fromEmail", "fromName"];

/** The fields that differ from what is saved (a typed password always counts: the saved one is never shown). */
export function changedFields(saved: SmtpForm, form: SmtpForm): SmtpField[] {
  return SMTP_FIELDS.filter((f) => (f === "password" ? form.password !== "" : form[f] !== saved[f]));
}

// backend _SMTP_HOST_FORBIDDEN = re.compile(r"[\s/\\@:]")
const HOST_FORBIDDEN = /[\s/\\@:]/;
// A plain address: what the From line and the envelope sender can carry (formataddr refuses anything not ASCII).
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function hostProblem(host: string): string | null {
  const h = host.trim();
  if (!h) return "SMTP host cannot be blank (for Gmail use smtp.gmail.com).";
  if (HOST_FORBIDDEN.test(h)) return "Just the server name, such as smtp.gmail.com (no spaces, port or https://).";
  return null;
}

export function portProblem(port: string): string | null {
  const p = port.trim();
  if (!/^\d+$/.test(p)) return "Type the port as a whole number, such as 587.";
  const n = Number(p);
  if (n < 1 || n > 65535) return "SMTP port must be a number from 1 to 65535 (587 for Gmail).";
  return null;
}

export function usernameProblem(username: string): string | null {
  return username.trim() ? null : "SMTP username cannot be blank (for Gmail this is the full Gmail address).";
}

export function fromEmailProblem(fromEmail: string): string | null {
  const e = fromEmail.trim();
  if (!e || ADDRESS.test(e)) return null;
  return "Just the address, such as hr@uktextiles.in (the name goes in From Name).";
}

/**
 * Problems that stop a save, for the fields being sent only: the server judges only what a save carries, so a value
 * saved long ago is never in the way of changing something else.
 */
export function smtpErrors(saved: SmtpForm, form: SmtpForm): Partial<Record<SmtpField, string>> {
  const changed = new Set(changedFields(saved, form));
  const errors: Partial<Record<SmtpField, string>> = {};
  const check = (field: SmtpField, problem: string | null) => {
    if (changed.has(field) && problem) errors[field] = problem;
  };
  check("host", hostProblem(form.host));
  check("port", portProblem(form.port));
  check("username", usernameProblem(form.username));
  check("fromEmail", fromEmailProblem(form.fromEmail));
  return errors;
}

/** The PUT body: only the fields that changed, cleaned the way the server stores them. No password = keep it. */
export function smtpPayload(saved: SmtpForm, form: SmtpForm): Partial<PayrollSettingsItem> {
  const body: Partial<PayrollSettingsItem> = {};
  for (const field of changedFields(saved, form)) {
    if (field === "host") body.smtpHost = form.host.trim();
    if (field === "port") body.smtpPort = Number(form.port.trim());
    if (field === "username") body.smtpUsername = form.username.trim();
    if (field === "password") body.smtpPassword = form.password;
    if (field === "fromEmail") body.smtpFromEmail = form.fromEmail.trim();
    if (field === "fromName") body.smtpFromName = form.fromName.trim();
  }
  return body;
}

export const isGmailHost = (host: string) => /gmail|googlemail/i.test(host);

/** Gmail Control's "Provider" (email_control_views._config). */
export const providerLabel = (host: string) => (isGmailHost(host) ? "Gmail (SMTP)" : "SMTP mail server");

/** email_service._deliver: port 465 is SSL from the first byte; every other port starts plain and switches (STARTTLS). */
export function connectionSecurity(port: number): { label: string; explain: string } {
  if (port === 465) return { label: "SSL (port 465)", explain: "encrypted from the first byte" };
  return { label: "STARTTLS", explain: "starts plain and switches to encryption before signing in" };
}

/** How Gmail Control shows the login (email_control_views._mask): enough to recognise it, not enough to read it out. */
export function maskLogin(value: string): string {
  if (!value) return "";
  const at = value.indexOf("@");
  if (at < 0) return `${value.slice(0, 2)}•••`;
  const domain = value.slice(at + 1);
  return domain ? `${value.slice(0, Math.min(2, at))}•••@${domain}` : `${value.slice(0, 2)}•••`;
}

/** email_service.smtp_missing_reason: every email is refused while any of these is blank. */
export function missingPieces(form: SmtpForm, passwordSaved: boolean): string[] {
  const missing: string[] = [];
  if (!form.host.trim()) missing.push("mail server");
  if (!form.username.trim()) missing.push("username");
  if (!form.password && !passwordSaved) missing.push("App Password");
  return missing;
}

// email.utils formataddr: a name with any of these is put in quotes, and \ and " inside it are escaped.
const SPECIALS = /[\][\\()<>@,:;".]/;

/**
 * The From line every email carries (email_service._build_message: formataddr((from_name, from_email or username))).
 * `display` is what an inbox shows; `header` is the line itself (a name that is not plain ASCII is sent encoded).
 */
export function fromLine(
  fromName: string,
  fromEmail: string,
  username: string,
): { address: string; name: string; header: string; encoded: boolean } {
  const address = fromEmail.trim() || username.trim();
  const name = fromName.trim();
  if (!name) return { address, name, header: address, encoded: false };
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(name)) return { address, name, header: `${name} <${address}>`, encoded: true };
  const quotes = SPECIALS.test(name) ? '"' : "";
  return { address, name, header: `${quotes}${name.replace(/[\\"]/g, "\\$&")}${quotes} <${address}>`, encoded: false };
}

/** Gmail sends as the signed-in account unless the From address is one of its verified "Send mail as" addresses. */
export function gmailMayRewriteFrom(form: SmtpForm): boolean {
  const from = form.fromEmail.trim().toLowerCase();
  const user = form.username.trim().toLowerCase();
  return isGmailHost(form.host) && !!from && !!user && from !== user;
}

/** Advice that does not stop a save. */
export function smtpWarnings(form: SmtpForm): Partial<Record<SmtpField, string>> {
  const gmail = isGmailHost(form.host);
  const warnings: Partial<Record<SmtpField, string>> = {};
  const port = Number(form.port.trim());
  if (gmail && !portProblem(form.port) && port !== 587 && port !== 465) {
    warnings.port = "Gmail takes 587 (STARTTLS) or 465 (SSL); other ports will fail.";
  }
  if (gmail && form.username.trim() && !form.username.includes("@")) {
    warnings.username = "For Gmail this is the full Gmail address, such as hr.uktex@gmail.com.";
  }
  const letters = form.password.replace(/\s/g, "");
  if (gmail && form.password && letters.length !== 16) {
    warnings.password = `A Gmail App Password has 16 letters; this has ${letters.length}.`;
  }
  return warnings;
}

/** Whether mail can actually leave this server, from Gmail Control's own status (null when this role cannot read it). */
export type MailGate = { sendingAllowedHere: boolean; emailsEnabled: boolean | null } | null;

/** The truthful line under "SMTP settings saved": what the saved account will and will not do next. */
export function saveOutcome({
  branchLogin,
  gate,
  missing,
}: {
  branchLogin: boolean;
  gate: MailGate;
  missing: string[];
}): string {
  const parts: string[] = [];
  if (branchLogin) parts.push("Saved for your branch only: emails sent from this branch's logins use it.");
  if (missing.length) {
    parts.push(`No email can be sent until the ${listWords(missing)} ${missing.length > 1 ? "are" : "is"} saved.`);
  } else if (!gate) {
    parts.push(
      "The next email uses this account, as long as Gmail Control's switches allow it. Send a test from Gmail Control.",
    );
  } else if (!gate.sendingAllowedHere) {
    parts.push("This server is a development setup, so it does not send email at all (Gmail Control explains why).");
  } else if (gate.emailsEnabled === false) {
    parts.push('Gmail Control\'s master switch "Send emails" is off, so nothing is emailed until it is turned on.');
  } else {
    parts.push("The next email goes out through this account. Send a test from Gmail Control to check it.");
  }
  return parts.join(" ");
}

export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The message the server sent with an error ({"error": "..."}), without customFetch's "HTTP 400 Bad Request:" prefix. */
export function serverMessage(e: unknown): string | undefined {
  if (e instanceof ApiError) {
    const data = e.data as { error?: unknown; message?: unknown } | null;
    if (typeof data?.message === "string" && data.message) return data.message;
    if (typeof data?.error === "string" && data.error) return data.error;
  }
  return e instanceof Error && e.message ? e.message : undefined;
}
