// The links the apps get for a contact, worked out exactly as the server works them out for GET /api/support-contact,
// so the Settings page can show them before saving.

const digitsOf = (value: string): string => value.replace(/\D/g, "");

/** What a "Call" button dials: the digits as typed, keeping a leading + (support_contact_views._dial). */
export function dialFor(raw: string): string {
  const digits = digitsOf(raw);
  return (digits && raw.trim().startsWith("+") ? "+" : "") + digits;
}

/**
 * The number a "WhatsApp" button opens a chat with (whatsapp_service.normalize_phone): a leading 00 or 0 is dropped,
 * and the server's country code (91 unless the server is set up with another) is put in front unless the number
 * already starts with it followed by ten more digits. A number from another country therefore gets 91 in front too.
 */
export function whatsappNumberFor(raw: string, countryCode = "91"): string {
  let digits = digitsOf(raw);
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith(countryCode) && digits.length >= countryCode.length + 10) return digits;
  return `${countryCode}${digits}`;
}

/** True when the typed WhatsApp number had an international prefix the server will not keep (+44..., 0044...). */
export function looksForeign(raw: string, countryCode = "91"): boolean {
  const trimmed = raw.trim();
  const digits = digitsOf(trimmed);
  const international = trimmed.startsWith("+") ? digits : digits.startsWith("00") ? digits.slice(2) : "";
  return international !== "" && !international.startsWith(countryCode);
}
