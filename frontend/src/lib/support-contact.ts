// HR / software-support contacts (Settings -> HR Contact), as the public GET /api/support-contact returns them.
// The same answer is shown in the Employee Web App and the mobile app; this module is the portal's copy of the
// rules they share, so what HR previews in Settings is what employees get:
//   "hr"     -> cannot sign in, password / OTP problems, account inactive, problems with an app
//   "server" -> the server is not working / unreachable, the database is offline
// The last good answer is kept in localStorage, because the moment the contact is needed most (the server is
// down) is the moment it can't be asked for.

export type SupportContactBlock = {
  label: string;
  /** As HR typed it, for display. */
  phone: string;
  /** What a tel: link should dial. */
  phoneDial: string;
  whatsapp: string;
  /** International digits for a wa.me link. */
  whatsappNumber: string;
  email: string;
  hours: string;
  /** At least one of phone / WhatsApp / email is set. */
  hasContact: boolean;
  /** Software support only: nothing is set for it, so this is the HR contact. */
  usesHrFallback: boolean;
};

export type SupportContact = {
  hr: SupportContactBlock;
  support: SupportContactBlock;
  note: string;
  companyName: string;
  /** False until HR has entered at least one way to reach someone. */
  configured: boolean;
  updatedAt: string | null;
};

export type SupportSituation = "hr" | "server";

export const SUPPORT_CONTACT_STORAGE_KEY = "uktex_support_contact_v1";

export const FALLBACK_TEXT: Record<SupportSituation, string> = {
  hr: "Please contact your HR department.",
  server: "Please contact your software support team.",
};

const isText = (value: unknown): value is string => typeof value === "string";

function isBlock(value: unknown): value is SupportContactBlock {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    ["label", "phone", "phoneDial", "whatsapp", "whatsappNumber", "email", "hours"].every((k) => isText(b[k])) &&
    typeof b.hasContact === "boolean"
  );
}

/** Does an API answer (or a stored copy) look like the contract? Anything else is ignored, never shown. */
export function isSupportContact(value: unknown): value is SupportContact {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isBlock(v.hr) && isBlock(v.support) && isText(v.note) && typeof v.configured === "boolean";
}

export function readCachedSupportContact(): SupportContact | null {
  try {
    const raw = window.localStorage.getItem(SUPPORT_CONTACT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSupportContact(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedSupportContact(value: SupportContact): void {
  try {
    window.localStorage.setItem(SUPPORT_CONTACT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be full, blocked or absent (private windows); the contact then just isn't remembered.
  }
}

export const dialHref = (block: SupportContactBlock): string => (block.phoneDial ? `tel:${block.phoneDial}` : "");
export const whatsappHref = (block: SupportContactBlock): string =>
  block.whatsappNumber ? `https://wa.me/${block.whatsappNumber}` : "";
export const mailHref = (block: SupportContactBlock): string => (block.email ? `mailto:${block.email}` : "");

/** The contact to show for a situation, or null when nothing is known (not loaded, or not configured yet). */
export function contactFor(
  data: SupportContact | null | undefined,
  situation: SupportSituation,
): SupportContactBlock | null {
  if (!data) return null;
  const block = situation === "server" ? data.support : data.hr;
  return block?.hasContact ? block : null;
}

// ── Settings -> HR Contact form ──────────────────────────────────────────────

export type ContactForm = {
  hrContactName: string;
  hrContactPhone: string;
  hrContactWhatsapp: string;
  hrContactEmail: string;
  hrContactHours: string;
  supportContactName: string;
  supportContactPhone: string;
  supportContactWhatsapp: string;
  supportContactEmail: string;
  supportContactHours: string;
  contactNote: string;
};

export const CONTACT_FORM_KEYS = [
  "hrContactName",
  "hrContactPhone",
  "hrContactWhatsapp",
  "hrContactEmail",
  "hrContactHours",
  "supportContactName",
  "supportContactPhone",
  "supportContactWhatsapp",
  "supportContactEmail",
  "supportContactHours",
  "contactNote",
] as const satisfies readonly (keyof ContactForm)[];

export const CONTACT_FIELD_LABELS: Record<keyof ContactForm, string> = {
  hrContactName: "HR contact name",
  hrContactPhone: "HR phone number",
  hrContactWhatsapp: "HR WhatsApp number",
  hrContactEmail: "HR email",
  hrContactHours: "HR available hours",
  supportContactName: "Software support name",
  supportContactPhone: "Software support phone number",
  supportContactWhatsapp: "Software support WhatsApp number",
  supportContactEmail: "Software support email",
  supportContactHours: "Software support available hours",
  contactNote: "Note",
};

const MAX_LENGTH: Record<keyof ContactForm, number> = {
  hrContactName: 80,
  hrContactPhone: 30,
  hrContactWhatsapp: 30,
  hrContactEmail: 120,
  hrContactHours: 120,
  supportContactName: 80,
  supportContactPhone: 30,
  supportContactWhatsapp: 30,
  supportContactEmail: 120,
  supportContactHours: 120,
  contactNote: 500,
};

const PHONE_CHARS = /^[0-9+ ()\-.]+$/;
const EMAIL = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;
const digitsOf = (value: string) => value.replace(/\D/g, "");

/** The same checks the server makes (which stays the authority), so a typo is caught before Save. Blank is fine. */
export function validateContactField(key: keyof ContactForm, raw: string): string | null {
  const value = key === "contactNote" ? raw.trim() : raw.split(/\s+/).filter(Boolean).join(" ");
  const label = CONTACT_FIELD_LABELS[key];
  if (value.length > MAX_LENGTH[key]) return `${label} must be at most ${MAX_LENGTH[key]} characters`;
  if (!value) return null;
  if (key.endsWith("Phone") || key.endsWith("Whatsapp")) {
    const digits = digitsOf(value).length;
    if (!PHONE_CHARS.test(value) || value.indexOf("+", 1) !== -1 || digits < 6 || digits > 15) {
      return `${label} must be one phone number (6-15 digits; spaces and + - ( ) are fine)`;
    }
  }
  if (key.endsWith("Email") && !EMAIL.test(value)) return `${label} must be a valid email address`;
  return null;
}

/** First problem in the whole form, or null. */
export function validateContactForm(form: ContactForm): string | null {
  for (const key of CONTACT_FORM_KEYS) {
    const problem = validateContactField(key, form[key]);
    if (problem) return problem;
  }
  return null;
}

const DEFAULT_HR_LABEL = "HR Department";
const DEFAULT_SUPPORT_LABEL = "Software Support";

function previewBlock(
  name: string,
  phone: string,
  whatsapp: string,
  email: string,
  hours: string,
  fallbackLabel: string,
) {
  const dial = digitsOf(phone);
  const wa = digitsOf(whatsapp);
  const block: SupportContactBlock = {
    label: name.trim() || fallbackLabel,
    phone: phone.trim(),
    phoneDial: (dial && phone.trim().startsWith("+") ? "+" : "") + dial,
    whatsapp: whatsapp.trim(),
    // The server adds the country code when it builds the real wa.me number; a preview only needs it to exist.
    whatsappNumber: wa,
    email: email.trim(),
    hours: hours.trim(),
    hasContact: Boolean(dial || wa || email.trim()),
    usesHrFallback: false,
  };
  return block;
}

/** What employees would see for the values typed in the form (used for the live preview, before saving). */
export function previewFromForm(form: ContactForm, companyName = ""): SupportContact {
  const hr = previewBlock(
    form.hrContactName,
    form.hrContactPhone,
    form.hrContactWhatsapp,
    form.hrContactEmail,
    form.hrContactHours,
    DEFAULT_HR_LABEL,
  );
  let support = previewBlock(
    form.supportContactName,
    form.supportContactPhone,
    form.supportContactWhatsapp,
    form.supportContactEmail,
    form.supportContactHours,
    DEFAULT_SUPPORT_LABEL,
  );
  if (!support.hasContact && hr.hasContact) support = { ...hr, usesHrFallback: true };
  return {
    hr,
    support,
    note: form.contactNote.trim(),
    companyName,
    configured: hr.hasContact || support.hasContact,
    updatedAt: null,
  };
}
