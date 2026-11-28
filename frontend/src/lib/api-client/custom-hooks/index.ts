// All hand-written API hooks, grouped by domain. Import from "@/lib/api-client/custom-hooks"
// (or the "@/lib/api-client" barrel) exactly as before -the split is organisational.
export * from "./shared";
export * from "./accounts";
export * from "./approval";
export * from "./attendance";
export * from "./biometric";
export * from "./device-status";
export * from "./device-control";
export * from "./chat";
export * from "./compensation";
export * from "./compensation-settings";
// OT Detection claims for an employee (the compensation claim workflow, 2026-11-19)
export * from "./compensation-ot-claims";
// Claims of every kind, the balance (earned / used / waiting / available), the ledger and the Raise month strip (2026-11-19)
export * from "./compensation-claims";
// Birthday Compensation on a chosen date (2026-11-25): a worked birthday's 1.00 day placed in the birthday month
export * from "./birthday-compensation";
// Compensation days on a date HR chooses (2026-11-28): Shift / OT / Sunday / Holiday work compensation or the balance
export * from "./compensation-placement";
export * from "./documents";
export * from "./gate";
// Gate Pass / Visitors / Tea Break rebuild (2026-11-18): one file per slice, the record row the gate pages share
export * from "./gate-records";
export * from "./gate-admin";
export * from "./gate-monitor";
export * from "./gate-inout";
export * from "./visitor-admin";
export * from "./reception-admin";
export * from "./tea-break-admin";
export * from "./geo";
export * from "./geo-tracking";
export * from "./geo-day-map";
export * from "./growth";
export * from "./organization";
export * from "./payroll";
export * from "./pf-esi";
export * from "./pf-esi-settings";
export * from "./production-cycles";
export * from "./production-shift-rules";
export * from "./production-shifts";
export * from "./shared-endpoints";
export * from "./payroll-insights";
export * from "./payroll-month";
// Staff Payroll's "Not included" view (2026-11-20): every employee not in the month's payroll, with the reason
export * from "./payroll-not-included";
// Staff Payroll's Payslip tab (2026-11-20): the month's payroll employees only, with the full payslip breakdown
export * from "./staff-payslips";
// The Excess tab of Staff Payroll (2026-11-20): amounts HR adds to / takes off the month's earned salary, with history
export * from "./payroll-excess";
// The standalone Salary Slip page (/hr/salary-slip, 2026-11-20): slips for any employee, statement, bank file, Hold
export * from "./salary-slip-center";
// The Missed Payroll page (/hr/missed-payroll, 2026-11-23): employees the regular payroll missed; Generate, Clear, Done, Paid
export * from "./missed-payroll";
export * from "./recruitment";
export * from "./reports";
export * from "./requests";
export * from "./casual-leave-policy";
// Settings -> Auto-Reject Requests (2026-11-24): waiting requests rejected after N days, nightly and by Run now
export * from "./request-auto-reject";
export * from "./shifts";
export * from "./system";
export * from "./whatsapp";
export * from "./mobile-messages";
export * from "./gmail";
export * from "./sms-control";
export * from "./hod-reminders";
export * from "./attendance-notify";
export * from "./support";
export * from "./md";
export * from "./md-admin";
// Employees -> Factory Employees (2026-11-20): drivers, housekeeping, chefs, security; their labels and the list
export * from "./factory-employees";
// Employees -> Investigation (2026-11-23): employees away 15 / 30+ days in a row, Keep active / Mark inactive, Auto Trigger
export * from "./employee-investigation";
// Employee Enquiries (2026-11-24): the mobile app's questions to HR, handled as a to-do list
export * from "./enquiries";
