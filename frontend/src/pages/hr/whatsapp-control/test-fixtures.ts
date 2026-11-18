// Server answers for the WhatsApp Control render tests (the shapes of backend/api/whatsapp_test_views.py and
// whatsapp_control_views.py on 2026-11-17). Each builder returns a fresh object, so a test can change its copy.
import type { WhatsAppControlTemplate } from "@/lib/api-client/custom-hooks";

export const CONFIG = {
  provider: "WAClient (WhatsApp Web API)",
  configured: true,
  instanceId: "…C042",
  apiUrl: "https://api.waclient.test/send",
  defaultCountryCode: "91",
  sendDelaySeconds: 2,
  publicBaseUrl: "https://api.example.test",
  webhookUrl: "https://api.example.test/api/whatsapp/webhook/",
  webhookTokenSet: false,
  backgroundSending: true,
};

export const feature = (key: string, group: string, label: string, enabled = true) => ({
  key,
  group,
  label,
  description: `${label} description`,
  enabled,
});

/** The switches with the Department Head section (2026-11-17), the approvals master OFF as on the dev database. */
export const settings = (
  over: { engineEnabled?: boolean; hodOn?: boolean; waitingOn?: boolean; reminderOn?: boolean } = {},
) => ({
  engineEnabled: over.engineEnabled ?? true,
  groups: [
    { key: "approvals", title: "Approval notifications (automatic)", blurb: "Approved and rejected." },
    { key: "hod", title: "Department Head notifications", blurb: "Messages to the heads." },
  ],
  features: [
    feature("approvalNotificationsEnabled", "approvals", "Approval notifications (all)", false),
    feature("approvalLeaveEnabled", "approvals", "Leave approval / rejection", true),
    feature("hodNotificationsEnabled", "hod", "Department Head notifications (all)", over.hodOn ?? true),
    feature("hodRequestWaitingEnabled", "hod", "New request waiting for approval", over.waitingOn ?? true),
    feature("type:hod_pending_reminder", "hod", "HoD Pending Approvals Reminder", over.reminderOn ?? true),
  ],
  timings: [],
  queueLimits: [],
  quietHours: { enabled: false, start: "21:00", end: "07:00" },
  config: CONFIG,
  updatedAt: null,
});

export const template = (
  documentType: string,
  category: string,
  categoryLabel: string,
  state: Partial<Pick<WhatsAppControlTemplate, "featureEnabled" | "moduleEnabled" | "isEnabled">> = {},
): WhatsAppControlTemplate => ({
  documentType,
  label: documentType.replace(/_/g, " "),
  description: "",
  category,
  categoryLabel,
  hasWording: true,
  messageBody: "",
  defaultMessage: "Hello {{employee_name}}",
  placeholders: "",
  variables: [],
  preview: "Hello Asha Kumar",
  isEnabled: state.isEnabled ?? true,
  featureEnabled: state.featureEnabled ?? null,
  moduleEnabled: state.moduleEnabled ?? null,
  customised: false,
  updatedAt: null,
  total: 0,
  failed: 0,
  lastSentAt: null,
});

/** The dev database on 2026-11-17: everything off but the Attendance Notify reports and the two Department Head messages. */
export const DEV_TEMPLATES = (): WhatsAppControlTemplate[] => [
  template("salary_slip", "documents", "Documents", { featureEnabled: false, moduleEnabled: false }),
  template("id_card", "documents", "Documents", { featureEnabled: false, moduleEnabled: false }),
  template("otp_login", "otp", "OTP & Login", { featureEnabled: false }),
  template("absent_alert", "attendance", "Attendance", { featureEnabled: false, moduleEnabled: false }),
  template("approval_approved", "approvals", "Approvals", { featureEnabled: false, moduleEnabled: false }),
  template("hod_request_waiting", "hod", "Department Heads", { featureEnabled: true, moduleEnabled: true }),
  template("hod_pending_reminder", "hod", "Department Heads", { moduleEnabled: true }),
  template("geo_approval", "geo", "Geo Attendance", { featureEnabled: false }),
  template("attendance_report", "other", "Other"),
];

/** The connection check as the dev machine answers it: connected, limited to 30020, documents can't be fetched. */
export const connection = (over: Record<string, unknown> = {}) => ({
  ok: false,
  problems: [
    "Documents cannot be sent from here: WAClient can't download the PDF from 'http://localhost:8000' because it isn't reachable from the internet. Set BACKEND_PUBLIC_URL to the server's public address.",
  ],
  credentials: true,
  instance: "…C042",
  apiHost: "api.waclient.com",
  machine: { developmentMachine: true, sendingAllowed: true, blockReason: null, limitedTo: ["30020"] },
  provider: {
    ok: true,
    state: "connected",
    socketLoaded: true,
    reloginRequired: false,
    httpStatus: 200,
    raw: { status: "success", data: { connection_state: "connected", instance_id: "…C042" } },
  },
  queue: {
    engineEnabled: true,
    paused: false,
    pausedReason: null,
    inQuietHours: false,
    queued: 0,
    sentToday: 1,
    failedToday: 0,
  },
  documents: {
    publicBase: "http://localhost:8000",
    problem:
      "WAClient can't download the PDF from 'http://localhost:8000' because it isn't reachable from the internet. Set BACKEND_PUBLIC_URL to the server's public address.",
  },
  lastFailure: {
    at: "2026-09-29T09:35:13+00:00",
    error: "WAClient can't download documents.",
    documentType: "salary_slip",
  },
  checkedAt: "2026-11-17T13:06:45+00:00",
  ...over,
});

export const SURYA = {
  id: 71,
  code: "30020",
  name: "SURYA M",
  phone: "••••9103",
  hasPhone: true,
  blockedReason: null,
};

export const TYPES = [
  {
    documentType: "salary_slip",
    label: "Salary Slip",
    module: "documents",
    moduleLabel: "Documents",
    kind: "document",
    variables: [
      { name: "employee_name", sample: "Asha Kumar" },
      { name: "month_year", sample: "August 2026" },
    ],
  },
  {
    documentType: "hod_request_waiting",
    label: "New request waiting for approval",
    module: "hod",
    moduleLabel: "Department Heads",
    kind: "automatic",
    variables: [{ name: "employee_name", sample: "Asha Kumar" }],
  },
];

/** GET test-message on a machine limited to 30020 (search ignored). */
export const limitedOptions = (over: Record<string, unknown> = {}) => ({
  blockReason: null,
  limitedTo: ["30020"],
  recipients: [SURYA],
  types: TYPES,
  ...over,
});
