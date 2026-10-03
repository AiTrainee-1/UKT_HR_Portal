import { SPLIT_FIELDS } from "@/lib/salary-split";
import type { Category, ListStatus, RowStatus } from "./types";

// The two sheet layouts. Keep the header lists in sync with backend/api/employee_bulk_views.py (STAFF_UPLOAD_HEADERS,
// PRODUCTION_UPLOAD_HEADERS): the backend refuses a file whose columns differ. config.test.ts pins the lists.

const SPLIT_HEADERS = SPLIT_FIELDS.map((f) => f.label);

const COMMON_HEAD = [
  "Employee Code",
  "First Name",
  "Last Name",
  "Email",
  "Phone",
  "Gender",
  "Date of Birth",
  "Department",
  "Designation",
  "Branch",
  "Join Date",
] as const;

const COMMON_TAIL = [
  "Bank Name",
  "Bank Account",
  "Bank IFSC",
  "PF Number",
  "ESI Number",
  "Address",
  "ID Proof",
  "Father's Name",
  "Mother's Name",
  "Biometric Device ID",
  "Blood Group",
  "Emergency Contact",
] as const;

export const STATUS_HEADER = "Status";

export const STAFF_HEADERS: string[] = [
  ...COMMON_HEAD,
  "Salary Type",
  "Salary Amount",
  ...SPLIT_HEADERS,
  ...COMMON_TAIL,
];
export const PRODUCTION_HEADERS: string[] = [...COMMON_HEAD, "Salary Per Shift", ...COMMON_TAIL];

/** Columns whose digits are an identifier, not an amount: written as text in every sheet. */
export const TEXT_COLUMNS = new Set([
  "Employee Code",
  "Phone",
  "Bank Account",
  "Bank IFSC",
  "PF Number",
  "ESI Number",
  "Biometric Device ID",
  "Emergency Contact",
]);

export const REQUIRED_COLUMNS = new Set(["Employee Code", "First Name"]);

export type ColumnGroup = "identity" | "job" | "pay" | "bank" | "personal";

export const GROUP_LABEL: Record<ColumnGroup, string> = {
  identity: "Identity & contact",
  job: "Job",
  pay: "Pay",
  bank: "Bank & statutory",
  personal: "Personal",
};

/** Header cell colour (ARGB) of each group in the downloaded sheets, so a wide sheet reads in sections. */
export const GROUP_FILL: Record<ColumnGroup, string> = {
  identity: "FF0F4C63",
  job: "FF1B4B6E",
  pay: "FF0B6B4F",
  bank: "FF5B4A9B",
  personal: "FF8A5A12",
};

const GROUPS: Record<string, ColumnGroup> = {
  ...Object.fromEntries(
    ["Employee Code", "First Name", "Last Name", "Email", "Phone", "Gender", "Date of Birth"].map((h) => [
      h,
      "identity",
    ]),
  ),
  ...Object.fromEntries(["Department", "Designation", "Branch", "Join Date"].map((h) => [h, "job"])),
  ...Object.fromEntries(["Salary Type", "Salary Amount", "Salary Per Shift", ...SPLIT_HEADERS].map((h) => [h, "pay"])),
  ...Object.fromEntries(["Bank Name", "Bank Account", "Bank IFSC", "PF Number", "ESI Number"].map((h) => [h, "bank"])),
  ...Object.fromEntries(
    [
      "Address",
      "ID Proof",
      "Father's Name",
      "Mother's Name",
      "Biometric Device ID",
      "Blood Group",
      "Emergency Contact",
    ].map((h) => [h, "personal"]),
  ),
  [STATUS_HEADER]: "identity",
};

export const groupOf = (header: string): ColumnGroup => GROUPS[header] ?? "personal";

const SPLIT_NOTE =
  "Optional. Leave all eight split columns blank and the Salary Amount is split 50% + 50% for you. If you fill any, " +
  "blanks count as 0 and they must give exactly 50% (Basic + DA + Retaining Allowance) and 50% (Other + Petrol + HRA + " +
  "Special Allowance + CA) of the Salary Amount.";

export const COLUMN_NOTES: Record<string, string> = {
  "Employee Code": "Required. Unique for every employee: the system never lets two share one.",
  "First Name": "Required.",
  "Last Name": "Optional: can be filled in later.",
  Email: "Optional.",
  Phone: "Optional here (the Add Employee form requires it).",
  Gender: "Type exactly: Male, Female or Other.",
  "Date of Birth": "Format DD-MM-YYYY, for example 15-01-1995.",
  Department: "Matched by name. A department that does not exist yet is created.",
  Designation:
    "Matched by title in the employee's department. A designation that does not exist yet is created. Leave blank to keep the current one.",
  Branch: "Must match an existing branch name exactly. A branch login always uses its own branch.",
  "Join Date": "Format DD-MM-YYYY, for example 01-06-2024.",
  "Salary Type": "Type exactly: Monthly or Weekly.",
  "Salary Amount": "The monthly (or weekly) amount, as chosen in Salary Type. It is split 50% + 50%.",
  "Salary Per Shift": "What one shift pays. Payroll skips a production employee until it is set.",
  "Biometric Device ID": "The number the punch machine knows this employee by.",
  [STATUS_HEADER]: "Active or Inactive. Change it to make someone Inactive, or active again.",
  ...Object.fromEntries(SPLIT_HEADERS.map((h) => [h, SPLIT_NOTE])),
};

export type CategoryConfig = {
  key: Category;
  label: string;
  tagline: string;
  /** What this kind of employee is paid by, in one line. */
  payLine: string;
  headers: string[];
  /** Tailwind classes, written out in full so they are generated. */
  accent: {
    text: string;
    soft: string;
    ring: string;
    solid: string;
    border: string;
    chip: string;
    gradient: string;
  };
  /** Sheet colour of the tab in Excel (ARGB). */
  sheetFill: string;
};

export const CATEGORIES: Record<Category, CategoryConfig> = {
  staff: {
    key: "staff",
    label: "Staff",
    tagline: "Monthly salaried employees",
    payLine: "Salary Amount (monthly or weekly) with the 50% + 50% split",
    headers: STAFF_HEADERS,
    accent: {
      text: "text-emerald-700",
      soft: "bg-emerald-50",
      ring: "ring-emerald-500",
      solid: "bg-emerald-600 hover:bg-emerald-700",
      border: "border-emerald-200",
      chip: "bg-emerald-100 text-emerald-800 border-emerald-200",
      gradient: "from-emerald-50 via-white to-white",
    },
    sheetFill: "FF0B6B4F",
  },
  production: {
    key: "production",
    label: "Production",
    tagline: "Paid per shift worked",
    payLine: "Salary Per Shift, with no salary split",
    headers: PRODUCTION_HEADERS,
    accent: {
      text: "text-amber-700",
      soft: "bg-amber-50",
      ring: "ring-amber-500",
      solid: "bg-amber-600 hover:bg-amber-700",
      border: "border-amber-200",
      chip: "bg-amber-100 text-amber-800 border-amber-200",
      gradient: "from-amber-50 via-white to-white",
    },
    sheetFill: "FF9A5B0B",
  },
};

export const STATUS_LABEL: Record<ListStatus, string> = { active: "Active", inactive: "Inactive" };

/** The columns of a download of existing employees: the same as the template, plus the trailing Status. */
export const exportHeaders = (category: Category): string[] => [...CATEGORIES[category].headers, STATUS_HEADER];

type Row = Record<string, string | number>;

const staffSamples: Row[] = [
  {
    "Employee Code": "SAMPLE001",
    "First Name": "Priya",
    "Last Name": "Sharma",
    Email: "priya.sharma@example.com",
    Phone: "9876543210",
    Gender: "Female",
    "Date of Birth": "12-03-1995",
    Department: "Human Resources",
    Designation: "HR Executive",
    Branch: "Head Office",
    "Join Date": "01-04-2023",
    "Salary Type": "Monthly",
    "Salary Amount": 25000,
    Basic: "8000.00",
    DA: "3000.00",
    "Retaining Allowance": "1500.00",
    "Other Allowance": "3000.00",
    "Petrol Allowance": "2000.00",
    HRA: "3500.00",
    "Special Allowance": "3000.00",
    CA: "1000.00",
    "Bank Name": "State Bank of India",
    "Bank Account": "123456789012",
    "Bank IFSC": "SBIN0001234",
    "PF Number": "PF12345",
    "ESI Number": "ESI67890",
    Address: "12 MG Road, Coimbatore",
    "ID Proof": "Aadhaar",
    "Father's Name": "Ramesh Sharma",
    "Mother's Name": "Sunita Sharma",
    "Biometric Device ID": "101",
    "Blood Group": "B+",
    "Emergency Contact": "9876500000",
  },
  {
    "Employee Code": "SAMPLE002",
    "First Name": "Anitha",
    "Last Name": "Kumar",
    Email: "anitha.kumar@example.com",
    Phone: "9988776655",
    Gender: "Female",
    Department: "Accounts",
    "Join Date": "10-02-2024",
    "Salary Type": "Monthly",
    "Salary Amount": 22000,
  },
  {
    "Employee Code": "SAMPLE003",
    "First Name": "Vikram",
    Phone: "9000011111",
    Department: "Stores",
    "Salary Type": "Weekly",
    "Salary Amount": 6000,
  },
];

const productionSamples: Row[] = [
  {
    "Employee Code": "SAMPLE001",
    "First Name": "Karthik",
    "Last Name": "Raja",
    Phone: "9123456780",
    Gender: "Male",
    "Date of Birth": "22-07-1998",
    Department: "Stitching",
    Designation: "Machine Operator",
    Branch: "Unit1",
    "Join Date": "15-01-2024",
    "Salary Per Shift": 350,
    "Bank Name": "Indian Bank",
    "Bank Account": "987654321098",
    "Bank IFSC": "IDIB000K123",
    "PF Number": "PF54321",
    "ESI Number": "ESI09876",
    Address: "45 Textile Nagar, Tirupur",
    "ID Proof": "Voter ID",
    "Father's Name": "Raja Mohan",
    "Mother's Name": "Lakshmi Raja",
    "Biometric Device ID": "202",
    "Blood Group": "O+",
    "Emergency Contact": "9123400000",
  },
  {
    "Employee Code": "SAMPLE002",
    "First Name": "Selvi",
    "Last Name": "M",
    Phone: "9345678901",
    Gender: "Female",
    Department: "Packing",
    "Join Date": "03-03-2024",
    "Salary Per Shift": 330,
  },
  {
    "Employee Code": "SAMPLE003",
    "First Name": "Mani",
    Phone: "9456789012",
    Department: "Cutting",
    "Salary Per Shift": 360,
  },
];

/** The reference rows of a template, each aligned to the category's columns. Their code starts with SAMPLE: skipped on upload. */
export function sampleRows(category: Category): (string | number)[][] {
  const rows = category === "staff" ? staffSamples : productionSamples;
  return rows.map((r) => CATEGORIES[category].headers.map((h) => r[h] ?? ""));
}

/** The look of each row outcome in the results. `order` is the order of the filter chips. */
export const ROW_STATUS_META: Record<
  RowStatus,
  { label: string; plural: string; chip: string; tile: string; dot: string; order: number }
> = {
  created: {
    label: "Created",
    plural: "Created",
    chip: "bg-green-100 text-green-800 border-green-200",
    tile: "text-green-700",
    dot: "bg-green-500",
    order: 0,
  },
  updated: {
    label: "Updated",
    plural: "Updated",
    chip: "bg-blue-100 text-blue-800 border-blue-200",
    tile: "text-blue-700",
    dot: "bg-blue-500",
    order: 1,
  },
  unchanged: {
    label: "Unchanged",
    plural: "Unchanged",
    chip: "bg-slate-100 text-slate-600 border-slate-200",
    tile: "text-slate-600",
    dot: "bg-slate-400",
    order: 2,
  },
  duplicate: {
    label: "Duplicate",
    plural: "Duplicates",
    chip: "bg-orange-100 text-orange-800 border-orange-200",
    tile: "text-orange-700",
    dot: "bg-orange-500",
    order: 3,
  },
  invalid: {
    label: "Invalid",
    plural: "Invalid",
    chip: "bg-red-100 text-red-800 border-red-200",
    tile: "text-red-700",
    dot: "bg-red-500",
    order: 4,
  },
  failed: {
    label: "Failed",
    plural: "Failed",
    chip: "bg-rose-100 text-rose-800 border-rose-200",
    tile: "text-rose-700",
    dot: "bg-rose-500",
    order: 5,
  },
  not_found: {
    label: "Not found",
    plural: "Not found",
    chip: "bg-purple-100 text-purple-800 border-purple-200",
    tile: "text-purple-700",
    dot: "bg-purple-500",
    order: 6,
  },
  skipped: {
    label: "Skipped",
    plural: "Skipped",
    chip: "bg-yellow-100 text-yellow-800 border-yellow-200",
    tile: "text-yellow-700",
    dot: "bg-yellow-500",
    order: 7,
  },
};

export const ROW_STATUS_ORDER = (Object.keys(ROW_STATUS_META) as RowStatus[]).sort(
  (a, b) => ROW_STATUS_META[a].order - ROW_STATUS_META[b].order,
);

/** Rows that need the person's attention: a row that did not go through for a reason they can fix. */
export const PROBLEM_STATUSES: RowStatus[] = ["duplicate", "invalid", "failed", "not_found"];
