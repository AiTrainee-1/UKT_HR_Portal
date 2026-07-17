import { useRef, useState } from "react";
import { useLocation } from "wouter";
import ExcelJS from "exceljs";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useListEmployees, getListEmployeesQueryKey, type Employee } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import {
  ArrowLeft, Download, UploadCloud, FileSpreadsheet, CheckCircle2,
  XCircle, AlertTriangle, ListChecks, Info, Table2,
} from "lucide-react";

// Keep in sync with EMPLOYEE_UPLOAD_HEADERS in backend/api/views.py — the
// backend rejects the file outright if these don't match exactly.
const EMPLOYEE_TEMPLATE_HEADERS = [
  "Employee Code", "First Name", "Last Name", "Email", "Phone", "Gender",
  "Date of Birth", "Employment Type", "Department", "Designation", "Branch",
  "Salary Type", "Salary Amount", "Salary Per Shift", "Join Date",
  "Bank Name", "Bank Account", "Bank IFSC", "PF Number", "ESI Number",
  "Address", "ID Proof", "Father's Name", "Mother's Name",
  "Biometric Device ID", "Blood Group", "Emergency Contact",
] as const;

const REQUIRED_COLUMNS = new Set(["Employee Code", "First Name", "Last Name", "Phone"]);

const COLUMN_NOTES: Partial<Record<(typeof EMPLOYEE_TEMPLATE_HEADERS)[number], string>> = {
  "Date of Birth": "Format: DD-MM-YYYY (e.g. 15-01-1995)",
  "Employment Type": "Type exactly: Staff or Production",
  "Department": "Must match an existing department name — created automatically if new",
  "Designation": "Must match an existing designation title, or leave blank",
  "Branch": "Must match an existing branch name exactly, or leave blank",
  "Salary Type": "Type exactly: Monthly or Weekly",
  "Join Date": "Format: DD-MM-YYYY (e.g. 01-06-2024)",
  "Gender": "Type exactly: Male, Female or Other",
};

// Reference rows baked into every downloaded template. The backend
// recognises the "SAMPLE" prefix on Employee Code and skips these rows
// outright — they're never imported, whether or not the user deletes them.
const SAMPLE_ROWS: (string | number)[][] = [
  ["SAMPLE001", "Priya", "Sharma", "priya.sharma@example.com", "9876543210", "Female",
    "12-03-1995", "Staff", "Human Resources", "HR Executive", "Head Office",
    "Monthly", 25000, "", "01-04-2023",
    "State Bank of India", "123456789012", "SBIN0001234", "PF12345", "ESI67890",
    "12 MG Road, Coimbatore", "Aadhaar", "Ramesh Sharma", "Sunita Sharma",
    "101", "B+", "9876500000"],
  ["SAMPLE002", "Karthik", "Raja", "", "9123456780", "Male",
    "22-07-1998", "Production", "Stitching", "Machine Operator", "Unit1",
    "Weekly", "", 350, "15-01-2024",
    "Indian Bank", "987654321098", "IDIB000K123", "PF54321", "ESI09876",
    "45 Textile Nagar, Tirupur", "Voter ID", "Raja Mohan", "Lakshmi Raja",
    "202", "O+", "9123400000"],
  ["SAMPLE003", "Anitha", "Kumar", "anitha.kumar@example.com", "9988776655", "Female",
    "", "Staff", "Accounts", "", "",
    "Monthly", 22000, "", "10-02-2024",
    "", "", "", "", "", "", "", "", "", "", "", ""],
];

type UploadResult = {
  message: string;
  created: number;
  failed: number;
  sampleRowsSkipped?: number;
  errors: string[];
  warnings: string[];
};

/** "Unit1", "Head Office" for a branch-scoped login; "Admin" for the super admin; "AllBranches" for any other unscoped role (MD, Directors, branch-less HR). Used in downloaded filenames so it's obvious whose data a sheet belongs to. */
function scopeLabel(user: ReturnType<typeof useAuth>["user"]): string {
  if (user?.branchName) return user.branchName.replace(/[^a-zA-Z0-9]+/g, "");
  if (user?.isSuperAdmin) return "Admin";
  return "AllBranches";
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function styleHeaderRow(headerRow: ExcelJS.Row) {
  EMPLOYEE_TEMPLATE_HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    const isRequired = REQUIRED_COLUMNS.has(h);
    cell.value = isRequired ? `${h} *` : h;
    cell.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: isRequired ? "FF0F4C63" : "FF1B4B6E" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: "FF0A2E3E" } } };
    const note = COLUMN_NOTES[h];
    if (note) cell.note = { texts: [{ text: note }] };
  });
  headerRow.height = 32;
}

async function downloadTemplate(user: ReturnType<typeof useAuth>["user"]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UKTextiles HRMS";
  const ws = wb.addWorksheet("Employees");

  ws.columns = EMPLOYEE_TEMPLATE_HEADERS.map((h) => ({ key: h, width: Math.max(16, h.length + 4) }));

  styleHeaderRow(ws.getRow(1));

  // Sample rows — distinct amber fill so they read as "example", not "data".
  SAMPLE_ROWS.forEach((values) => {
    const row = ws.addRow(values);
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDF3D6" } };
      cell.font = { italic: true, color: { argb: "FF8A6D1D" } };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE8D69A" } },
        bottom: { style: "thin", color: { argb: "FFE8D69A" } },
        left: { style: "thin", color: { argb: "FFE8D69A" } },
        right: { style: "thin", color: { argb: "FFE8D69A" } },
      };
    });
  });

  // Banner row separating the sample block from where real data should start.
  // Its own Employee Code cell also starts with "SAMPLE" so the backend's
  // sample-row filter skips it too, instead of it being read as a (failing)
  // real data row with a very strange name.
  const bannerRow = ws.addRow([]);
  ws.mergeCells(bannerRow.number, 1, bannerRow.number, EMPLOYEE_TEMPLATE_HEADERS.length);
  const bannerCell = bannerRow.getCell(1);
  bannerCell.value = `SAMPLE ROWS ABOVE (2–${1 + SAMPLE_ROWS.length}) — for reference only, skipped automatically on upload. Enter your real employees starting from row ${bannerRow.number + 1} ⬇`;
  bannerCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B4B6E" } };
  bannerCell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
  bannerCell.alignment = { horizontal: "center", vertical: "middle" };
  bannerRow.height = 22;

  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Employee_Bulk_Upload_Template_${scopeLabel(user)}_${todayStamp()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function employeeToRow(emp: Employee): (string | number)[] {
  const e = emp as Employee & {
    fatherName?: string | null; motherName?: string | null;
    biometricDeviceId?: string | null; emergencyContact?: string | null;
  };
  const dmy = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  };
  const cap = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  return [
    e.employeeCode, e.firstName, e.lastName, e.email ?? "", e.phone ?? "", cap(e.gender),
    dmy(e.dateOfBirth), cap(e.employmentType), e.departmentName ?? "", e.designationTitle ?? "", e.branchName ?? "",
    cap(e.salaryType), e.salaryAmount ?? "", e.salaryPerShift ?? "", dmy(e.joinDate),
    e.bankName ?? "", e.bankAccount ?? "", e.bankIfsc ?? "", e.pfNumber ?? "", e.esiNumber ?? "",
    e.address ?? "", e.idProof ?? "", e.fatherName ?? "", e.motherName ?? "",
    e.biometricDeviceId ?? "", e.bloodGroup ?? "", e.emergencyContact ?? "",
  ];
}

async function downloadCurrentEmployees(employees: Employee[], user: ReturnType<typeof useAuth>["user"]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UKTextiles HRMS";
  const ws = wb.addWorksheet("Employees");
  ws.columns = EMPLOYEE_TEMPLATE_HEADERS.map((h) => ({ key: h, width: Math.max(16, h.length + 4) }));
  styleHeaderRow(ws.getRow(1));
  employees.forEach((emp) => ws.addRow(employeeToRow(emp)));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Employee_Data_Export_${scopeLabel(user)}_${todayStamp()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

const COLUMN_LETTERS = Array.from({ length: EMPLOYEE_TEMPLATE_HEADERS.length }, (_, i) => {
  let n = i, s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
});

export default function BulkUploadEmployees() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [invalidTemplate, setInvalidTemplate] = useState<string | null>(null);

  const { data: employees, isLoading: employeesLoading } = useListEmployees();

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);
    setInvalidTemplate(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`${window.location.origin}/api/employees/bulk-upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("uk_textile_token")}` },
        body: formData,
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.error === "invalid_template") {
          setInvalidTemplate(body.message);
        } else {
          throw new Error(body.message || body.error || "Upload failed");
        }
        return;
      }
      setResult(body as UploadResult);
      if (body.created > 0) {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        toast({ title: `${body.created} employee${body.created === 1 ? "" : "s"} imported` });
      }
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5 pb-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Bulk Employee Upload</h2>
            <p className="text-muted-foreground text-sm">
              Import many employees at once from a single Excel file.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* ── Step 1: Template ── */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-black shrink-0">1</div>
                <CardTitle className="text-base font-bold text-gray-900">Download the Template</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The template has one column for every field on the Add Employee form — {EMPLOYEE_TEMPLATE_HEADERS.length} in
                total — plus {SAMPLE_ROWS.length} sample rows showing how to fill it in. Columns marked with{" "}
                <span className="font-semibold text-gray-700">*</span> are required.
              </p>
              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-teal-600/10 flex items-center justify-center shrink-0">
                  <FileSpreadsheet size={20} className="text-teal-700" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-800 truncate">
                    Employee_Bulk_Upload_Template_{scopeLabel(user)}_{todayStamp()}.xlsx
                  </p>
                  <p className="text-xs text-muted-foreground">Column headers are locked — don't rename, reorder, or remove any of them.</p>
                </div>
              </div>
              <Button onClick={() => downloadTemplate(user)} className="w-full gap-2">
                <Download size={15} /> Download Template
              </Button>
            </CardContent>
          </Card>

          {/* ── Step 2: Upload ── */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-black shrink-0">2</div>
                <CardTitle className="text-base font-bold text-gray-900">Upload the Filled Sheet</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Fill in employee details below the sample rows, save it, then upload it here.
              </p>
              <label
                htmlFor="bulk-emp-file"
                className="relative border-2 border-dashed border-gray-200 hover:border-teal-400 transition rounded-xl p-6 flex flex-col items-center gap-2 text-center bg-gray-50/50 cursor-pointer block"
              >
                <input
                  id="bulk-emp-file"
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setInvalidTemplate(null); }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <UploadCloud size={30} className="text-teal-600" />
                <span className="text-sm font-semibold text-gray-700">
                  {file ? file.name : "Drag the filled Excel file here, or click to browse"}
                </span>
                <span className="text-xs text-muted-foreground">.xlsx or .xls, using the official template</span>
              </label>
              <Button onClick={handleUpload} disabled={!file || uploading} className="w-full gap-2">
                <UploadCloud size={15} /> {uploading ? "Uploading…" : "Upload & Create Employees"}
              </Button>

              {invalidTemplate && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2.5">
                  <XCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700 font-medium">{invalidTemplate}</p>
                </div>
              )}

              {result && (
                <div className="rounded-xl border border-gray-100 overflow-hidden">
                  <div className="grid grid-cols-2 divide-x divide-gray-100">
                    <div className="p-3 text-center bg-green-50/60">
                      <p className="text-2xl font-black text-green-700">{result.created}</p>
                      <p className="text-[11px] font-semibold text-green-700/80 uppercase tracking-wide">Created</p>
                    </div>
                    <div className={`p-3 text-center ${result.failed > 0 ? "bg-red-50/60" : "bg-gray-50"}`}>
                      <p className={`text-2xl font-black ${result.failed > 0 ? "text-red-700" : "text-gray-400"}`}>{result.failed}</p>
                      <p className={`text-[11px] font-semibold uppercase tracking-wide ${result.failed > 0 ? "text-red-700/80" : "text-gray-400"}`}>Failed</p>
                    </div>
                  </div>
                  {!!result.sampleRowsSkipped && (
                    <p className="border-t border-gray-100 px-3 py-2 text-xs text-amber-700 bg-amber-50/60">
                      {result.sampleRowsSkipped} reference row{result.sampleRowsSkipped === 1 ? "" : "s"} (sample data / instructions) in the file were ignored, as expected.
                    </p>
                  )}
                  {result.errors.length > 0 && (
                    <div className="border-t border-gray-100 p-3 space-y-1.5 max-h-48 overflow-y-auto">
                      <p className="text-xs font-bold text-red-700 flex items-center gap-1.5"><XCircle size={12} /> Rows that failed</p>
                      {result.errors.map((e, i) => (
                        <p key={i} className="text-xs text-red-600 pl-4">{e}</p>
                      ))}
                    </div>
                  )}
                  {result.warnings.length > 0 && (
                    <div className="border-t border-gray-100 p-3 space-y-1.5 max-h-40 overflow-y-auto">
                      <p className="text-xs font-bold text-amber-700 flex items-center gap-1.5"><AlertTriangle size={12} /> Warnings</p>
                      {result.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-amber-700 pl-4">{w}</p>
                      ))}
                    </div>
                  )}
                  {result.created > 0 && (
                    <div className="border-t border-gray-100 p-3">
                      <Button variant="outline" size="sm" className="w-full gap-2" onClick={() => navigate("/hr/employees")}>
                        <CheckCircle2 size={13} /> View Employees
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── User Guide ── */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ListChecks size={16} className="text-teal-700" />
              <CardTitle className="text-base font-bold text-gray-900">User Guide</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="grid sm:grid-cols-2 gap-3 text-sm">
              {[
                "Download the official template using the button above — don't build your own sheet from scratch.",
                `Rows 2–${1 + SAMPLE_ROWS.length} are sample data (shaded) — they're for reference only and are always skipped, whether or not you delete them.`,
                "Employee Code, First Name, Last Name and Phone are required for every row; every other column can be left blank.",
                "Department, Designation and Branch are matched by name — spell them exactly as they appear in Manage Branch / Departments / Designations.",
                "Already have employees in the system? Use \"Download Current Employees\" below instead — it's the same sheet with your real data already in it, so you can just add new rows at the bottom.",
                "After uploading, review the Created/Failed summary — failed rows list the exact reason, so you can fix just those rows and re-upload only them.",
              ].map((step, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-teal-50 text-teal-700 text-[11px] font-black flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                  <span className="text-gray-600">{step}</span>
                </li>
              ))}
            </ol>
            <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 flex items-start gap-2.5">
              <Info size={14} className="text-blue-600 shrink-0 mt-0.5" />
              <p className="text-xs text-blue-800">
                If the headers in your uploaded file don't match the official template exactly (renamed, reordered, or
                removed columns), the whole file is rejected before anything is imported — download a fresh copy of the
                template if you're unsure. Employee Code is the unique identifier for every employee — the system will
                never let two employees share one, in this upload or anywhere else.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Existing Employees ── */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Table2 size={16} className="text-teal-700" />
                <CardTitle className="text-base font-bold text-gray-900">Existing Employees</CardTitle>
                <span className="text-xs text-muted-foreground">({employees?.length ?? 0} records)</span>
              </div>
              <Button
                variant="outline" size="sm" className="gap-2"
                disabled={!employees?.length}
                onClick={() => employees && downloadCurrentEmployees(employees, user)}
              >
                <Download size={13} /> Download Current Employees
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {employeesLoading ? (
              <p className="text-sm text-muted-foreground p-4">Loading…</p>
            ) : !employees?.length ? (
              <p className="text-sm text-muted-foreground p-6 text-center">No employees yet — upload your first batch above.</p>
            ) : (
              <div className="overflow-auto border-t border-gray-100 max-h-[480px]" style={{ fontFamily: "ui-monospace, monospace" }}>
                <table className="border-collapse text-[11px]" style={{ minWidth: "max-content" }}>
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="sticky left-0 z-20 bg-gray-100 border border-gray-200 w-9 text-gray-400 font-normal" />
                      {COLUMN_LETTERS.map((l) => (
                        <th key={l} className="bg-gray-100 border border-gray-200 px-2 py-0.5 text-gray-400 font-normal min-w-[110px]">{l}</th>
                      ))}
                    </tr>
                    <tr>
                      <th className="sticky left-0 z-20 bg-gray-50 border border-gray-200 text-gray-400 font-normal" />
                      {EMPLOYEE_TEMPLATE_HEADERS.map((h) => (
                        <th key={h} className="bg-[#eaf2f7] border border-gray-200 px-2 py-1.5 text-[#0F4C63] font-bold text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((emp, ri) => (
                      <tr key={emp.id}>
                        <td className="sticky left-0 z-10 bg-gray-50 border border-gray-200 text-center text-gray-400">{ri + 1}</td>
                        {employeeToRow(emp).map((v, ci) => (
                          <td key={ci} className="border border-gray-200 px-2 py-1 whitespace-nowrap text-gray-700 bg-white">{v === "" ? "" : String(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}
