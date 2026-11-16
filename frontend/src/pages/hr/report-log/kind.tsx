import { createContext, useContext } from "react";
import type { ReportLogKind } from "@/lib/api-client/custom-hooks";

export type { ReportLogKind };

/**
 * Whose Report Log the page is: the staff Report Log (/hr/attendance/report-log) or the Production Report Log
 * (/hr/attendance/production-report-log, owner 2026-11-16). One set of tabs, filters, tables and downloads serves both; the
 * page names the kind once and every part below reads it from here, so the register, the daily lists, their department
 * pickers, the API addresses and the titles of the downloads always agree. Without a provider it is staff, so a part
 * used on its own (the Attendance Sheet's tests) is exactly as before.
 */
const ReportLogKindContext = createContext<ReportLogKind>("staff");

export const ReportLogKindProvider = ReportLogKindContext.Provider;

export const useReportLogKind = (): ReportLogKind => useContext(ReportLogKindContext);

/** The words that differ between the two pages. */
export type KindText = {
  /** "Staff" / "Production employees", at the start of a sentence. */
  people: string;
  /** "staff member" / "production employee", one of them in a sentence. */
  person: string;
  /** "STAFF" / "PRODUCTION" in a paper list's title ("16-11-2026 PRODUCTION LEAVE LIST"). */
  listWord: string;
  /** Put before a report's own name in its downloads ("Production Daily Late Report"); "" for staff, as before. */
  titlePrefix: string;
  /** The attendance page the same late flag is shown on. */
  attendancePage: string;
  /** The other kind, for "production workers are not part of this report". */
  others: string;
  /** The page itself. */
  pageTitle: string;
  pageHelp: string;
};

export const KIND_TEXT: Record<ReportLogKind, KindText> = {
  staff: {
    people: "Staff",
    person: "staff member",
    listWord: "STAFF",
    titlePrefix: "",
    attendancePage: "Staff Attendance",
    others: "production workers",
    pageTitle: "Report Log",
    pageHelp:
      "The colored attendance register, the late-penalty breakdown behind payroll's deductions, and the daily leave and late lists",
  },
  production: {
    people: "Production employees",
    person: "production employee",
    listWord: "PRODUCTION",
    titlePrefix: "Production ",
    attendancePage: "Production Attendance",
    others: "staff",
    pageTitle: "Production Report Log",
    pageHelp: "The colored attendance register and the daily leave and late lists of production employees",
  },
};

export const useKindText = (): KindText => KIND_TEXT[useReportLogKind()];
