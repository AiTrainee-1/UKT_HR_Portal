import type { SettingMeta } from "./kit/catalog";

const SECTION = "SMTP / Email Configuration";
const MAIL = ["email", "mail", "gmail", "smtp"];

/** Every setting on the Smtp tab, for the page's search (see kit/catalog.ts). */
export const SMTP_SETTINGS: SettingMeta[] = [
  {
    id: "smtp-host",
    tab: "smtp",
    section: SECTION,
    title: "SMTP Host",
    purpose:
      "The address of the mail server the portal signs in to whenever it sends an email. For a Gmail mailbox it is smtp.gmail.com.",
    keywords: [...MAIL, "server", "host", "provider"],
  },
  {
    id: "smtp-port",
    tab: "smtp",
    section: SECTION,
    title: "SMTP Port",
    purpose:
      "Which door on the mail server the portal uses. 587 starts plain and switches to encryption before signing in (STARTTLS); 465 is encrypted from the first byte (SSL).",
    keywords: [...MAIL, "port", "587", "465", "ssl", "tls", "starttls", "encryption"],
  },
  {
    id: "smtp-username",
    tab: "smtp",
    section: SECTION,
    title: "Username",
    purpose: "The login name of the mailbox the portal signs in with. For Gmail it is the full Gmail address.",
    keywords: [...MAIL, "login", "account", "user", "sign in"],
  },
  {
    id: "smtp-password",
    tab: "smtp",
    section: SECTION,
    title: "App Password",
    purpose:
      "The 16-letter Google App Password (not the Gmail account's own password) that lets the portal send through that account. Once saved it is never shown again and never sent to any page.",
    keywords: [...MAIL, "password", "app password", "2-step", "credentials", "secret"],
  },
  {
    id: "smtp-from-email",
    tab: "smtp",
    section: SECTION,
    title: "From Email",
    purpose: "The sender address employees see on every email. Leave it blank to send from the Username.",
    keywords: [...MAIL, "sender", "from", "reply", "address"],
  },
  {
    id: "smtp-from-name",
    tab: "smtp",
    section: SECTION,
    title: "From Name",
    purpose: "The name shown next to the sender address in the inbox, such as UKTextiles HR.",
    keywords: [...MAIL, "sender", "from", "name", "display name"],
  },
  {
    id: "smtp-gmail-control",
    tab: "smtp",
    section: "Testing and switching email",
    title: "Test email, on/off switches, wording and daily limit",
    purpose:
      "Send a test email through the account above, see whether this server may send, switch all email or one kind of email off, change the subject and wording of each email, and cap how many go out a day.",
    keywords: [...MAIL, "test", "switch", "wording", "subject", "template", "limit", "gmail control"],
  },
];
