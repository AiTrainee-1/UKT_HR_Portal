import type { SettingMeta } from "./kit/catalog";
import { COMPANY_SETTINGS } from "./CompanyTab.meta";
import { HR_CONTACT_SETTINGS } from "./HrContactTab.meta";
import { ATTENDANCE_SETTINGS } from "./AttendanceTab.meta";
import { PRODUCTION_SHIFT_SETTINGS } from "./ProductionShiftsTab.meta";
import { LATE_DETECTION_SETTINGS } from "./LateDetectionTab.meta";
import { COMPENSATION_SETTINGS } from "./CompensationTab.meta";
import { DEVICES_SETTINGS } from "./DevicesTab.meta";
import { ID_CARD_SETTINGS } from "./IdCardTab.meta";
import { DOCUMENTS_SETTINGS } from "./DocumentsTab.meta";
import { PAYROLL_SETTINGS } from "./PayrollTab.meta";
import { PRODUCTION_PAYROLL_SETTINGS } from "./ProductionPayrollTab.meta";
import { SALARY_SLIP_SETTINGS } from "./SalarySlipTab.meta";
import { SMTP_SETTINGS } from "./SmtpTab.meta";
import { WHATSAPP_SETTINGS } from "./WhatsAppTab.meta";
import { BACKUP_SETTINGS } from "./BackupTab.meta";
import { THEMES_SETTINGS } from "./ThemesTab.meta";
import { ENDPOINT_SHARING_SETTINGS } from "./EndpointSharingTab.meta";

/** All settings of all tabs, for the search box. */
export const ALL_SETTINGS: SettingMeta[] = [
  ...COMPANY_SETTINGS,
  ...HR_CONTACT_SETTINGS,
  ...ATTENDANCE_SETTINGS,
  ...PRODUCTION_SHIFT_SETTINGS,
  ...LATE_DETECTION_SETTINGS,
  ...COMPENSATION_SETTINGS,
  ...DEVICES_SETTINGS,
  ...ID_CARD_SETTINGS,
  ...DOCUMENTS_SETTINGS,
  ...PAYROLL_SETTINGS,
  ...PRODUCTION_PAYROLL_SETTINGS,
  ...SALARY_SLIP_SETTINGS,
  ...SMTP_SETTINGS,
  ...WHATSAPP_SETTINGS,
  ...BACKUP_SETTINGS,
  ...THEMES_SETTINGS,
  ...ENDPOINT_SHARING_SETTINGS,
];
