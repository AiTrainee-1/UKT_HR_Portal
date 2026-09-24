// Every logo/signature upload on this page goes into PayrollSettings as a
// base64 data URI inside an ordinary JSON PUT, not a multipart file upload
// -so it counts against the backend's request-body size cap, not a file-
// upload cap. Every upload below is compressed automatically via
// compressImageToDataUrl (Canvas API, no manual action needed) before it
// ever becomes a data URI, instead of just rejecting an oversized file -see
// config/settings.py's DATA_UPLOAD_MAX_MEMORY_SIZE comment for the incident
// this came from. PNG is used (not JPEG) to preserve transparency, which a
// logo or signature typically needs.

// Settings tab -> its own permission key. Each Settings tab has a distinct
// settings.* entry in Account Management (see permission_registry.py) except
// "idcard", which is deliberately governed by the existing "id_cards"
// permission -the same one that already gates the ID Cards feature page,
// not a separate Settings concern.
export const SETTINGS_TAB_MODULE: Record<string, string> = {
  company: "settings.company",
  attendance: "settings.attendance",
  late_detection: "settings.late_detection",
  devices: "settings.devices",
  idcard: "id_cards",
  documents: "settings.documents",
  payroll: "settings.payroll",
  production_payroll: "settings.production_payroll",
  "salary-slip": "settings.salary_slip",
  smtp: "settings.smtp",
  whatsapp: "settings.whatsapp",
  backup: "settings.backup",
  themes: "settings.themes",
};
