import type { SettingMeta } from "./kit/catalog";
import { COMPANY_SETTINGS } from "./CompanyTab.meta";
import { HR_CONTACT_SETTINGS } from "./HrContactTab.meta";
import { ATTENDANCE_SETTINGS, ATTENDANCE_VIEW_OF } from "./AttendanceTab.meta";
import { PRODUCTION_SHIFT_SETTINGS, PRODUCTION_SHIFT_VIEW_OF } from "./ProductionShiftsTab.meta";
import { LATE_CYCLE_OF, LATE_DETECTION_SETTINGS, LATE_VIEW_OF } from "./LateDetectionTab.meta";
import { COMPENSATION_SETTINGS } from "./CompensationTab.meta";
import { DEVICES_SETTINGS } from "./DevicesTab.meta";
import { ID_CARD_SETTINGS } from "./IdCardTab.meta";
import { DOCUMENTS_SETTINGS } from "./DocumentsTab.meta";
import { PAYROLL_SETTINGS, PAYROLL_SUB_TAB_OF } from "./PayrollTab.meta";
import { PRODUCTION_PAYROLL_SETTINGS, PRODUCTION_SUB_TAB_OF } from "./ProductionPayrollTab.meta";
import { PF_ESI_SETTINGS, PF_ESI_SUB_TAB_OF } from "./PfEsiTab.meta";
import { SALARY_SLIP_SETTINGS } from "./SalarySlipTab.meta";
import { SMTP_SETTINGS } from "./SmtpTab.meta";
import { WHATSAPP_SETTINGS } from "./WhatsAppTab.meta";
import { BACKUP_FEATURE_OF, BACKUP_SETTINGS } from "./BackupTab.meta";
import { THEMES_SETTINGS } from "./ThemesTab.meta";
import { ENDPOINT_SHARING_SETTINGS } from "./EndpointSharingTab.meta";
import { BACKUP_FEATURE_MODULE, LATE_CYCLE_MODULE, SETTINGS_SUBTAB_MODULE } from "./constants";

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
  ...PF_ESI_SETTINGS,
  ...SALARY_SLIP_SETTINGS,
  ...SMTP_SETTINGS,
  ...WHATSAPP_SETTINGS,
  ...BACKUP_SETTINGS,
  ...THEMES_SETTINGS,
  ...ENDPOINT_SHARING_SETTINGS,
];

const own = <T>(map: Record<string, T>, id: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;

/**
 * The permission keys a setting sits under below its tab, outermost first: its sub-tab (Staff / Production, a Payroll
 * sub-tab...), a cycle pill inside it (Late Detection -> Production -> Weekly), or a Backup part. The page's search offers a
 * setting only when none of them is hidden for the login (constants.ts SETTINGS_SUBTAB_MODULE). Empty for a setting that
 * is on its tab itself (and for Company Documents, whose settings belong to each of the four documents alike).
 */
export function settingPartKeys(meta: SettingMeta): string[] {
  const sub = SETTINGS_SUBTAB_MODULE[meta.tab] ?? {};
  const keyOf = (value: string | undefined): string[] => (value && sub[value] ? [sub[value]] : []);
  switch (meta.tab) {
    case "attendance":
      return keyOf(own(ATTENDANCE_VIEW_OF, meta.id));
    case "production_shifts":
      return keyOf(own(PRODUCTION_SHIFT_VIEW_OF, meta.id));
    case "late_detection": {
      const cycle = own(LATE_CYCLE_OF, meta.id);
      return [...keyOf(own(LATE_VIEW_OF, meta.id)), ...(cycle ? [LATE_CYCLE_MODULE[cycle]] : [])];
    }
    case "payroll":
      return keyOf(own(PAYROLL_SUB_TAB_OF, meta.id));
    case "production_payroll":
      return keyOf(own(PRODUCTION_SUB_TAB_OF, meta.id));
    case "pf_esi":
      return keyOf(own(PF_ESI_SUB_TAB_OF, meta.id));
    case "backup": {
      const feature = own(BACKUP_FEATURE_OF, meta.id);
      return feature ? [BACKUP_FEATURE_MODULE[feature]] : [];
    }
    default:
      return [];
  }
}
