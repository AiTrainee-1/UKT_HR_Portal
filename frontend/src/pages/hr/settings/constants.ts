// Every logo/signature upload on this page goes into PayrollSettings as a
// base64 data URI inside an ordinary JSON PUT, not a multipart file upload
// -so it counts against the backend's request-body size cap, not a file-
// upload cap. Every upload below is compressed automatically via
// compressImageToDataUrl (Canvas API, no manual action needed) before it
// ever becomes a data URI, instead of just rejecting an oversized file -see
// config/settings.py's DATA_UPLOAD_MAX_MEMORY_SIZE comment for the incident
// this came from. PNG is used (not JPEG) to preserve transparency, which a
// logo or signature typically needs.

// Settings tab -> its own permission key. Each Settings tab has a distinct settings.* entry in Account Management (see
// permission_tree.py). Three of them follow another key while they have no setting of their own (the tree's `inherits`,
// resolved by permissionLevel), so a role that never set them keeps what it had: Production Shifts follows
// settings.attendance, PF & ESI follows settings.payroll, ID Card follows the ID Cards page ("id_cards").
export const SETTINGS_TAB_MODULE: Record<string, string> = {
  company: "settings.company",
  hr_contact: "settings.hr_contact",
  attendance: "settings.attendance",
  production_shifts: "settings.production_shifts",
  late_detection: "settings.late_detection",
  compensation: "settings.compensation",
  devices: "settings.devices",
  idcard: "settings.idcard",
  documents: "settings.documents",
  payroll: "settings.payroll",
  production_payroll: "settings.production_payroll",
  // PF & ESI is read by every HR login that may see it; changing it is the super admin's alone (the API decides)
  pf_esi: "settings.pf_esi",
  "salary-slip": "settings.salary_slip",
  smtp: "settings.smtp",
  whatsapp: "settings.whatsapp",
  backup: "settings.backup",
  themes: "settings.themes",
};

// The sub-tabs (pill switches) inside a Settings tab -> their own permission keys. Each follows its tab while it has no
// setting of its own, so a role that never set one keeps exactly what it had. A hidden sub-tab is not offered (nor opened by
// the search or a #setting link); a View-only one is read-only. The server checks the settings fields of each one too.
export const SETTINGS_SUBTAB_MODULE: Record<string, Record<string, string>> = {
  attendance: { staff: "settings.attendance.staff", production: "settings.attendance.production" },
  production_shifts: { staff: "settings.production_shifts.staff", production: "settings.production_shifts.production" },
  late_detection: { staff: "settings.late_detection.staff", production: "settings.late_detection.production" },
  payroll: {
    rates: "settings.payroll.rates",
    bonus: "settings.payroll.bonus",
    otCompensation: "settings.payroll.ot_compensation",
  },
  production_payroll: {
    overview: "settings.production_payroll.overview",
    weekly: "settings.production_payroll.weekly",
    biweekly: "settings.production_payroll.biweekly",
    monthly: "settings.production_payroll.monthly",
    payBonus: "settings.production_payroll.pay_bonus",
  },
  pf_esi: { staff: "settings.pf_esi.staff", production: "settings.pf_esi.production" },
  documents: {
    offer_letter: "settings.documents.offer_letter",
    experience_letter: "settings.documents.experience_letter",
    salary_slip: "settings.documents.salary_slip",
    resignation_letter: "settings.documents.resignation_letter",
  },
};

// Late Detection -> Production's Weekly / BiWeekly / Monthly pills (inside its Production sub-tab).
export const LATE_CYCLE_MODULE: Record<string, string> = {
  weekly: "settings.late_detection.production.weekly",
  biweekly: "settings.late_detection.production.biweekly",
  monthly: "settings.late_detection.production.monthly",
};

// Backup's parts with a key of their own (features: hidden = not shown, View only = shown but cannot be changed).
export const BACKUP_FEATURE_MODULE: Record<string, string> = {
  schedule: "settings.backup.schedule",
  drive: "settings.backup.drive",
  restore: "settings.backup.restore",
};

/** Every sub-tab key under a Settings tab (pills and the pills inside them; not features), for "may any part be edited". */
export function subtabKeysOf(tab: string): string[] {
  const own = Object.values(SETTINGS_SUBTAB_MODULE[tab] ?? {});
  return tab === "late_detection" ? [...own, ...Object.values(LATE_CYCLE_MODULE)] : own;
}

// Tabs that are not a role permission at all: only the super admin sees them (the Settings page hides them from every other
// login, the search and the address alike, and their API refuses everybody else). They have no entry in SETTINGS_TAB_MODULE
// and no module in Account Management.
export const SUPER_ADMIN_ONLY_TABS: ReadonlySet<string> = new Set(["endpoint_sharing"]);

// Tabs that exist but are NOT offered anywhere in the page: not in the menu on the left and not in the page's search. They
// open only from their address (/hr/settings?tab=endpoint_sharing or /hr/settings/endpoint_sharing), which the person who
// needs one types in. The role rules above still decide who may open them.
export const UNLISTED_TABS: ReadonlySet<string> = new Set(["endpoint_sharing"]);
