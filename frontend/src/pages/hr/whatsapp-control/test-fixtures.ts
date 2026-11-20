// The answers of the WhatsApp Control endpoints the render tests give the page (the Meta Cloud API contract of
// 2026-11-20, scratchpad msg_spec.md). Every builder returns a fresh object so a test may change it.
import type { Fixtures } from "@/pages/md/testing/renderMdPage";

export const feature = (key: string, group: string, label: string, enabled = true) => ({
  key,
  group,
  label,
  description: `${label} description`,
  enabled,
});

export type SettingsFixture = Record<string, unknown> & {
  engineEnabled: boolean;
  otpEnabled: boolean;
  features: { key: string; enabled: boolean; group: string; label: string }[];
  timings: { key: string; value: number; min: number; max: number; label: string }[];
  queueLimits: (Record<string, unknown> & { key: string; value: number })[];
  quietHours: { enabled: boolean; start: string; end: string };
  templateOverrides: Record<string, string>;
  priceRates: Record<string, number | string>;
  monthlyBudget: number | string | null;
};

export const settingsFixture = (): SettingsFixture => ({
  engineEnabled: true,
  otpEnabled: true,
  groups: [
    { key: "signin", title: "Employee sign-in", blurb: "How employees get in." },
    { key: "documents", title: "Documents", blurb: "Salary slips and letters." },
    { key: "attendance", title: "Attendance alerts (automatic)", blurb: "Checked every minute." },
    { key: "approvals", title: "Approval notifications (automatic)", blurb: "Approved or rejected." },
    { key: "visitors", title: "Visitors", blurb: "Who is at reception." },
  ],
  features: [
    feature("otpLoginEnabled", "signin", "OTP login"),
    feature("otpResetEnabled", "signin", "OTP password reset"),
    feature("otpActivateEnabled", "signin", "OTP new-account activation", false),
    feature("passwordLoginEnabled", "signin", "Password login"),
    feature("documentNotificationsEnabled", "documents", "Document notifications"),
    feature("type:salary_slip", "documents", "Salary Slip"),
    feature("type:id_card", "documents", "ID Card"),
    feature("attendanceAlertsEnabled", "attendance", "Attendance alerts (all)", false),
    feature("lateAlertEnabled", "attendance", "Late attendance alert"),
    feature("absentAlertEnabled", "attendance", "Absent alert", false),
    feature("approvalNotificationsEnabled", "approvals", "Approval notifications (all)"),
    feature("leaveApprovalEnabled", "approvals", "Leave approval / rejection"),
    feature("type:approval_approved", "approvals", "Request Approved"),
    feature("visitorNotificationEnabled", "visitors", "Visitor notification"),
    feature("type:visitor_notification", "visitors", "Visitor Notification"),
    feature("type:visitor_contact", "visitors", "Visitor Contact Card", false),
  ],
  timings: [
    { key: "otpExpiryMinutes", label: "OTP expiry (minutes)", value: 5, min: 1, max: 30 },
    { key: "absentExtraMinutes", label: "Extra wait before an Absent alert (minutes)", value: 30, min: 0, max: 240 },
  ],
  queueLimits: [
    { key: "minGapSeconds", label: "Pause between two messages", value: 30, min: 5, max: 600, unit: "seconds" },
    { key: "maxPerHour", label: "Most messages in any hour", value: 60, min: 1, max: 1000, unit: "messages" },
    { key: "maxPerDay", label: "Most messages in a day", value: 200, min: 1, max: 5000, unit: "messages" },
    {
      key: "maxPerEmployeePerDay",
      label: "Most automatic messages to one employee",
      value: 3,
      min: 1,
      max: 20,
      unit: "messages",
    },
  ],
  quietHours: { enabled: true, start: "21:00", end: "07:00" },
  templateOverrides: {},
  priceRates: { authentication: "0.1150", utility: 0.115, marketing: 0.8631, service: 0 },
  monthlyBudget: "500.00",
  updatedAt: null,
});

const component = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

export const metaTemplatesFixture = () => ({
  configured: true,
  lastSyncedAt: "2026-11-20T09:00:00+05:30",
  templates: [
    {
      id: 1,
      name: "hrms_salary_slip",
      language: "en",
      category: "UTILITY",
      status: "APPROVED",
      qualityScore: "GREEN",
      rejectedReason: null,
      messageTypes: ["salary_slip"],
      components: [
        component("HEADER", { format: "DOCUMENT" }),
        component("BODY", {
          text: "Dear {{employee_name}},\nYour salary slip for {{month_year}} is attached.\n\n- UK Textiles HR",
          example: {
            body_text_named_params: [
              { param_name: "employee_name", example: "Asha Kumar" },
              { param_name: "month_year", example: "August 2026" },
            ],
          },
        }),
        component("FOOTER", { text: "UK Textiles HR" }),
      ],
      lastSyncedAt: "2026-11-20T09:00:00+05:30",
      metaId: "1180001",
    },
    {
      id: 2,
      name: "hrms_otp",
      language: "en",
      category: "AUTHENTICATION",
      status: "APPROVED",
      qualityScore: null,
      rejectedReason: null,
      messageTypes: ["otp_login", "otp_reset", "otp_activate"],
      components: [component("BODY", { add_security_recommendation: true })],
      lastSyncedAt: "2026-11-20T09:00:00+05:30",
      metaId: "1180002",
    },
    {
      id: 3,
      name: "hrms_late_alert",
      language: "en",
      category: "UTILITY",
      status: "REJECTED",
      qualityScore: null,
      rejectedReason: "INVALID_FORMAT",
      messageTypes: ["late_alert"],
      components: [component("BODY", { text: "Dear {{employee_name}}, you were late." })],
      lastSyncedAt: "2026-11-20T09:00:00+05:30",
      metaId: "1180003",
    },
    {
      id: 4,
      name: "hrms_visitor_notification",
      language: "en",
      category: "UTILITY",
      status: "PENDING",
      qualityScore: null,
      rejectedReason: null,
      messageTypes: ["visitor_notification"],
      components: [],
      lastSyncedAt: null,
      metaId: null,
    },
  ],
});

export const overviewFixture = () => ({
  connection: {
    configured: true,
    sendingAllowed: true,
    blockReasons: [],
    qualityRating: "GREEN",
    messagingLimitTier: "TIER_2K",
    displayNumber: "+91 98765 43210",
    verifiedName: "UK Textiles",
    status: "CONNECTED",
    lastWebhookAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  },
  month: { sent: 420, delivered: 300, read: 90, failed: 6, queued: 2, skipped: 11, deliveryRate: 0.93, readRate: 21.4 },
  cost: { soFar: 46.2, projected: 71.61, budget: 60, budgetUsedPct: 77, currency: "INR" },
  templates: {
    approved: 12,
    pending: 1,
    rejected: 1,
    missingForEnabledTypes: [{ type: "late_alert", label: "Late Attendance Alert", templateName: "hrms_late_alert" }],
  },
  otp: {
    enabled: true,
    available: true,
    templateStatus: "APPROVED",
    month: { sent: 120, delivered: 117, verified: 96 },
  },
  queue: {
    engineEnabled: true,
    paused: false,
    pausedReason: "",
    inQuietHours: false,
    queued: 2,
    sentToday: 40,
    sentLastHour: 6,
    failedToday: 1,
    expiredToday: 0,
    skippedToday: 3,
    nextSendAt: null,
    limits: { minGapSeconds: 30, maxPerHour: 60, maxPerDay: 200, maxPerEmployeePerDay: 3 },
  },
  alerts: [
    { level: "info", code: "budget_near", message: "77% of this month's budget is spent." },
    { level: "error", code: "template_rejected", message: "Meta rejected hrms_late_alert: Late alerts are skipped." },
    { level: "warning", code: "webhook_stale", message: "No delivery receipt for 2 days." },
  ],
});

export const usageFixture = (month = "2026-11") => ({
  month,
  days: [
    {
      date: `${month}-01`,
      sent: 20,
      delivered: 18,
      read: 5,
      failed: 1,
      byCategory: { authentication: 6, utility: 14, marketing: 0, service: 0 },
    },
    {
      date: `${month}-02`,
      sent: 30,
      delivered: 29,
      read: 9,
      failed: 0,
      byCategory: { authentication: 10, utility: 20, marketing: 0, service: 0 },
    },
  ],
  totals: { sent: 50, delivered: 47, read: 14, failed: 1, skipped: 4, billable: 46 },
  byCategory: {
    authentication: { messages: 16, billable: 16, rate: 0.115, cost: 1.84 },
    utility: { messages: 34, billable: 30, rate: 0.115, cost: 3.45 },
    marketing: { messages: 0, billable: 0, rate: 0.8631, cost: 0 },
    service: { messages: 0, billable: 0, rate: 0, cost: 0 },
  },
  byType: [
    { type: "otp_login", label: "Login OTP", module: "otp", messages: 16, cost: 1.84 },
    { type: "salary_slip", label: "Salary Slip", module: "documents", messages: 24, cost: 2.76 },
    { type: "late_alert", label: "Late Attendance Alert", module: "attendance", messages: 10, cost: 0.69 },
  ],
  cost: {
    soFar: 5.29,
    soFarWithGst: 6.24,
    projected: 79.35,
    projectedWithGst: 93.63,
    gstRate: 0.18,
    budget: 60,
    budgetUsedPct: 8.8,
    currency: "INR",
    isCurrentMonth: true,
  },
  rates: { authentication: 0.115, utility: 0.115, marketing: 0.8631, service: 0 },
  meta: {
    available: false,
    cost: null,
    volume: null,
    lastSyncedAt: null,
    error: "Meta's pricing analytics did not answer.",
  },
});

export const connectionFixture = () => ({
  env: [
    // The server's own list (whatsapp_cloud.env_status): names only, never a value.
    { name: "WHATSAPP_CLOUD_PHONE_NUMBER_ID", set: true, secret: false, required: true },
    { name: "WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID", set: true, secret: false, required: true },
    { name: "WHATSAPP_CLOUD_ACCESS_TOKEN", set: true, secret: true, required: true },
    { name: "WHATSAPP_CLOUD_APP_SECRET", set: false, secret: true, required: true },
    { name: "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN", set: true, secret: true, required: true },
    { name: "WHATSAPP_CLOUD_API_VERSION", set: true, secret: false, required: false },
    { name: "WHATSAPP_CLOUD_API_BASE", set: false, secret: false, required: false },
  ],
  configured: true,
  sendingAllowed: true,
  blockReasons: [],
  phone: {
    display_phone_number: "+91 98765 43210",
    verified_name: "UK Textiles",
    quality_rating: "GREEN",
    messaging_limit_tier: "TIER_2K",
    status: "CONNECTED",
    name_status: "APPROVED",
    code_verification_status: "VERIFIED",
    throughput: { level: "STANDARD" },
    platform_type: "CLOUD_API",
  },
  tokenOk: true,
  error: null,
  apiVersion: "v23.0",
  webhook: {
    url: "https://hrms.example.test/api/whatsapp/webhook/",
    verifyTokenSet: true,
    appSecretSet: false,
    lastWebhookAt: null,
  },
  devLock: { onlyToEmployees: ["30020"] },
});

export const queueFixture = () => overviewFixture().queue;

/** A settings endpoint: GET answers the state, PATCH records the body and applies it (or refuses when told to). */
export function settingsServer(initial: SettingsFixture = settingsFixture()) {
  const state = initial;
  const patches: Record<string, unknown>[] = [];
  const methods: string[] = [];
  let refusal: { status: number; body: unknown } | null = null;
  const fixture = (_params: URLSearchParams, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return state;
    methods.push(method);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    patches.push(body);
    if (refusal) return refusal;
    for (const [key, value] of Object.entries(body)) {
      if (key === "engineEnabled") state.engineEnabled = value as boolean;
      else if (key === "otpEnabled") state.otpEnabled = value as boolean;
      else if (key === "quietHours") state.quietHours = { ...state.quietHours, ...(value as object) };
      else if (key === "priceRates") state.priceRates = value as Record<string, number>;
      else if (key === "monthlyBudget") state.monthlyBudget = value as number | null;
      else if (key === "templateOverrides") state.templateOverrides = value as Record<string, string>;
      else {
        const f = state.features.find((x) => x.key === key);
        if (f) f.enabled = value as boolean;
        const l = state.queueLimits.find((x) => x.key === key);
        if (l) l.value = value as number;
        const t = state.timings.find((x) => x.key === key);
        if (t) t.value = value as number;
      }
    }
    return state;
  };
  return {
    state,
    fixture,
    patches,
    methods,
    refuse: (status: number, body: unknown) => {
      refusal = { status, body };
    },
  };
}

/** Every endpoint the page may read on its first screen, answered with the fixtures above. */
export function pageFixtures(settings = settingsServer()): Fixtures {
  return {
    "/api/whatsapp-control/settings": settings.fixture,
    "/api/whatsapp-control/overview": overviewFixture(),
    "/api/whatsapp-control/usage": (params) => usageFixture(params.get("month") ?? "2026-11"),
    "/api/whatsapp-control/meta-templates": metaTemplatesFixture(),
    "/api/whatsapp-control/queue": queueFixture(),
    "/api/whatsapp-control/connection": connectionFixture(),
    "/api/whatsapp-control/messages": { items: [], total: 0, page: 1, pageSize: 25 },
    "/api/whatsapp-control/employees": { items: [], total: 0, page: 1, pageSize: 25 },
  };
}

/** An administrator (every tab, edit). */
export const ADMIN = { role: "hr", employeeId: null, name: "Test HR", isSuperAdmin: true, permissions: {} };

/** An HR login with these levels. */
export const hrWith = (permissions: Record<string, "hidden" | "view" | "edit">) => ({
  role: "hr",
  employeeId: null,
  name: "Test HR",
  isSuperAdmin: false,
  permissions,
});
