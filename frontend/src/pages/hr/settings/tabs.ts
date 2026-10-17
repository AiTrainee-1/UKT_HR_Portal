import { lazy, type ComponentType } from "react";
import {
  AlertTriangle,
  Building2,
  Clock,
  CreditCard,
  Database,
  Factory,
  FileSignature,
  FileText,
  Fingerprint,
  Headset,
  Hourglass,
  IndianRupee,
  Mail,
  MessageCircle,
  Palette,
  Share2,
  Timer,
} from "lucide-react";
import type { SettingsTabDef } from "./kit/catalog";

export type SettingsTabComponent = ComponentType<{ readOnly?: boolean }>;

/**
 * The Settings tabs, in the order and groups the navigation shows them. `purpose` and `usedBy` are what the tab's heading
 * says; the tab itself explains each setting. A tab's id is also its permission key (constants.ts SETTINGS_TAB_MODULE)
 * and the `?tab=` of the page address, so do not rename one.
 */
export const SETTINGS_TABS: SettingsTabDef[] = [
  {
    id: "company",
    label: "Company",
    group: "organisation",
    icon: Building2,
    purpose:
      "The company's name, logo, address and contact details, as the sidebar, letters, salary slips, ID cards, emails and report headers show them.",
    usedBy: [
      { label: "Sidebar" },
      { label: "Letters and salary slips", to: "/hr/recruitment/documents" },
      { label: "ID cards", to: "/hr/id-cards" },
      { label: "Report Center", to: "/hr/reports" },
    ],
  },
  {
    id: "hr_contact",
    label: "HR Contact",
    group: "organisation",
    icon: Headset,
    purpose: "Who employees are told to contact in HR and in software support when they need help.",
    usedBy: [
      { label: "Employee web app" },
      { label: "Mobile app" },
      { label: "Sign-in page", to: "/employee-login" },
      { label: "Server-down screens" },
    ],
  },
  {
    id: "themes",
    label: "Themes",
    group: "organisation",
    icon: Palette,
    purpose:
      "The colour scheme every page of this portal is drawn in, for every user at once, with six colours of it open to change. The employee apps are not themed.",
    usedBy: [{ label: "HR portal pages" }, { label: "Employee pages in the portal" }, { label: "Sign-in pages" }],
  },
  {
    id: "attendance",
    label: "Attendance",
    group: "time",
    icon: Clock,
    purpose:
      "How a staff day's punches become Full Day, Half Day or Absent, and when a staff member is marked Late or Early Out. Production attendance has its own tab, Production Shifts.",
    usedBy: [
      { label: "Staff Attendance", to: "/hr/attendance/staff" },
      { label: "Report Log", to: "/hr/attendance/report-log" },
      { label: "Staff Payroll", to: "/hr/payroll" },
      { label: "Employee apps" },
    ],
  },
  {
    id: "production_shifts",
    label: "Production Shifts",
    group: "time",
    icon: Timer,
    purpose:
      "Production only: how a production worker's punches become shifts earned. The factory's own timings (Day from 8:30 AM, Night from 9:00 PM, Sunday), what each leaving time earns, the unpaid breaks and a 5-minute grace, all editable. Shifts earned times the salary per shift is the pay. Staff are never affected.",
    usedBy: [
      { label: "Production Attendance", to: "/hr/attendance/production" },
      { label: "Production Payroll", to: "/hr/production-payroll" },
      { label: "Manage Shifts", to: "/hr/shifts" },
      { label: "HR Reports", to: "/hr/reports" },
    ],
  },
  {
    id: "late_detection",
    label: "Late Detection",
    group: "time",
    icon: AlertTriangle,
    purpose:
      "Staff only: how many Late, Early Out and extra-permission marks are free each month, what the rest cost in salary, and how many approved permissions a month protect a day. Production late rules are on Production Payroll.",
    usedBy: [
      { label: "Staff Payroll", to: "/hr/payroll" },
      { label: "Report Log", to: "/hr/attendance/report-log" },
      { label: "Permissions", to: "/hr/leave" },
      { label: "Employee apps" },
    ],
  },
  {
    id: "compensation",
    label: "Compensation",
    group: "time",
    icon: Hourglass,
    purpose:
      "Staff only: the rules and switches for OT Detection (the automatic next-day late-in allowance and shift-based compensation, given as Relaxation or Payment) and for Compensation Leave (announced late-in / early-out, work on Sundays and holidays, birthday). Each feature has its own switch; the master switch is on Payroll.",
    usedBy: [
      { label: "Compensation", to: "/hr/compensation/ot-detection" },
      { label: "Staff Attendance", to: "/hr/attendance/staff" },
      { label: "Staff Payroll", to: "/hr/payroll" },
      { label: "Employee apps" },
    ],
  },
  {
    id: "devices",
    label: "Devices",
    group: "time",
    icon: Fingerprint,
    purpose:
      "The biometric punching machines the portal reads punches from, or receives them from, and how each one is reached. Watching and operating them is done on Device Status and Device Control.",
    usedBy: [
      { label: "Staff Attendance sync", to: "/hr/attendance/staff" },
      { label: "Device Status", to: "/hr/Biometric-Connectors/device-status" },
      { label: "Device Control", to: "/hr/Biometric-Connectors/DeviceControl" },
    ],
  },
  {
    id: "payroll",
    label: "Payroll",
    group: "pay",
    icon: IndianRupee,
    purpose:
      "What payslips deduct and add: PF and ESI for staff and for production, statutory bonus and overtime pay, plus the salary day and the financial year.",
    usedBy: [
      { label: "Staff Payroll", to: "/hr/payroll" },
      { label: "Production Payroll", to: "/hr/production-payroll" },
      { label: "Bonus", to: "/hr/bonus" },
      { label: "Compensation", to: "/hr/compensation/ctc-breakdown" },
    ],
  },
  {
    id: "production_payroll",
    label: "Production Payroll",
    group: "pay",
    icon: Factory,
    purpose:
      "How often production workers are paid (the pay period) and what late arrivals cost them. Shifts earned come from the Production Shifts tab; PF and ESI from the Payroll tab.",
    usedBy: [
      { label: "Production Payroll", to: "/hr/production-payroll" },
      { label: "Manage Shifts", to: "/hr/shifts" },
    ],
  },
  {
    id: "salary-slip",
    label: "Salary Slip",
    group: "pay",
    icon: FileText,
    purpose:
      "The name and address at the top of every salary slip, the minimum wage printed on it, and the signature images used by slips, letters and ID cards.",
    usedBy: [
      { label: "Staff Payroll", to: "/hr/payroll" },
      { label: "Production Payroll", to: "/hr/production-payroll" },
      { label: "Employee apps" },
    ],
  },
  {
    id: "documents",
    label: "Company Documents",
    group: "documents",
    icon: FileSignature,
    purpose:
      "The look of offer letters, experience letters, salary slips and resignation letters: colours, heading font, footer slogan, watermark and an optional logo for each.",
    usedBy: [
      { label: "Recruitment Documents", to: "/hr/recruitment/documents" },
      { label: "Payroll slips", to: "/hr/payroll" },
    ],
  },
  {
    id: "idcard",
    label: "ID Card",
    group: "documents",
    icon: CreditCard,
    purpose:
      "The colours, typeface and layout of employee ID cards, and whether the back carries a QR verification code.",
    usedBy: [{ label: "ID Cards", to: "/hr/id-cards" }, { label: "Employee apps" }],
  },
  {
    id: "smtp",
    label: "SMTP / Email",
    group: "system",
    icon: Mail,
    purpose: "The mail account the portal sends email from.",
    usedBy: [{ label: "Gmail Control", to: "/hr/gmail-control" }],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    group: "system",
    icon: MessageCircle,
    purpose:
      "Where WhatsApp messaging is set up: the connection, the wording and the on/off switches all live on WhatsApp Control.",
    usedBy: [{ label: "WhatsApp Control", to: "/hr/whatsapp-control" }],
  },
  {
    id: "endpoint_sharing",
    label: "Endpoint Sharing",
    group: "system",
    icon: Share2,
    purpose:
      "Super admin only: share chosen HR data with your other applications through read-only web addresses. You pick the data and the exact fields, the websites that may call each address and the API keys, and you read the guide a developer needs.",
    usedBy: [{ label: "Your other applications" }],
  },
  {
    id: "backup",
    label: "Backup",
    group: "system",
    icon: Database,
    purpose:
      "Full backups of the database and every uploaded file: taken now or on a schedule, how many are kept, a Google Drive copy, and restoring one.",
    usedBy: [],
  },
];

const loaders: Record<string, () => Promise<{ default: SettingsTabComponent }>> = {
  company: () => import("./CompanyTab"),
  hr_contact: () => import("./HrContactTab"),
  themes: () => import("./ThemesTab"),
  attendance: () => import("./AttendanceTab"),
  production_shifts: () => import("./ProductionShiftsTab"),
  late_detection: () => import("./LateDetectionTab"),
  compensation: () => import("./CompensationTab"),
  devices: () => import("./DevicesTab"),
  payroll: () => import("./PayrollTab"),
  production_payroll: () => import("./ProductionPayrollTab"),
  "salary-slip": () => import("./SalarySlipTab"),
  documents: () => import("./DocumentsTab"),
  idcard: () => import("./IdCardTab"),
  smtp: () => import("./SmtpTab"),
  whatsapp: () => import("./WhatsAppTab"),
  endpoint_sharing: () => import("./EndpointSharingTab"),
  backup: () => import("./BackupTab"),
};

/** One lazily loaded component per tab id (a tab's code is fetched when it is first opened). */
export const SETTINGS_TAB_COMPONENTS: Record<string, SettingsTabComponent> = Object.fromEntries(
  Object.entries(loaders).map(([id, load]) => [id, lazy(load)]),
);
