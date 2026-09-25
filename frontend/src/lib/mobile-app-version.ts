// Version numbers and download links for the Mobile App Login -> New Version tab. The server checks the
// same rules (backend/api/mobile_app_version_views.py); these give the person typing an answer before they
// press Publish.

const VERSION_RE = /^\d{1,4}(\.\d{1,4}){1,3}$/;

/** "3.0.10" -> [3, 0, 10], or null if it isn't dotted numbers. Trailing zeros are dropped: 3.0 equals 3.0.0. */
export function parseVersion(value: string): number[] | null {
  const text = value.trim().replace(/^[vV]/, "");
  if (!VERSION_RE.test(text)) return null;
  const parts = text.split(".").map(Number);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts;
}

export const isValidVersion = (value: string): boolean => parseVersion(value) !== null;

/** Negative when a is older than b, 0 when the same release, positive when newer. Invalid versions sort oldest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The version after this one, as a person would number it: 3.0.0 -> 3.0.1. */
export function suggestNextVersion(latest: string): string | null {
  const parts = parseVersion(latest);
  if (!parts) return null;
  const padded = [...parts];
  while (padded.length < 3) padded.push(0);
  padded[2] += 1;
  return padded.slice(0, 3).join(".");
}

export const isWebLink = (value: string): boolean => /^https?:\/\/\S+$/i.test(value.trim());

/** A Google Drive "share" page link; the server turns these into direct downloads. */
export function isDriveShareLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^www\./, "");
    return (
      (host === "drive.google.com" || host === "docs.google.com") &&
      /\/file\/d\/|[?&]id=/.test(url.pathname + url.search)
    );
  } catch {
    return false;
  }
}
