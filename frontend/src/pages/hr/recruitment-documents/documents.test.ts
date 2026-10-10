import { describe, expect, it } from "vitest";
import type { DocumentCompletionStats, EmployeeDocumentItem } from "@/lib/api-client/custom-hooks";
import {
  buildTracker,
  categoryStatus,
  checkUpload,
  completion,
  filterTracker,
  filtersActive,
  lastDayBeforeJoining,
  missingOptions,
  NO_DEPARTMENT,
  NO_FILTERS,
  requiredCategories,
  sortTracker,
  summarizeTracker,
} from "./logic";

const PAN = { value: "pan_card", label: "PAN Card" } as const;
const AADHAAR = { value: "aadhaar_card", label: "Aadhaar Card" } as const;
const BANK = { value: "bank_passbook", label: "Bank Passbook" } as const;

const stats: DocumentCompletionStats = {
  totalCount: 4,
  uploadedCount: 1,
  pendingCount: 3,
  uploadedEmployees: [{ id: 1, employeeCode: "E001", name: "Asha Kumar", departmentName: "Stitching" }],
  pendingEmployees: [
    {
      id: 2,
      employeeCode: "E002",
      name: "Ravi Singh",
      departmentName: "Cutting",
      missingCategories: [PAN, AADHAAR, BANK],
    },
    { id: 3, employeeCode: "E003", name: "Meena Das", departmentName: "Stitching", missingCategories: [PAN] },
    { id: 4, employeeCode: "E004", name: "Bala Raj", departmentName: null, missingCategories: [AADHAAR] },
  ],
};

const rows = buildTracker(stats, 6);

const doc = (over: Partial<EmployeeDocumentItem>): EmployeeDocumentItem => ({
  id: 1,
  employeeId: 1,
  category: "pan_card",
  categoryLabel: "PAN Card",
  originalFilename: "pan.pdf",
  uploadedBy: "HR",
  uploadedAt: "2026-03-01T10:00:00Z",
  fileUrl: "/api/employee-documents/1/file",
  ...over,
});

describe("required documents", () => {
  it("is the common five plus one that depends on the type, like the server", () => {
    expect(requiredCategories("staff")).toEqual([
      "pan_card",
      "aadhaar_card",
      "educational_certificate",
      "voter_id_or_birth_certificate",
      "bank_passbook",
      "staff_letter",
    ]);
    expect(requiredCategories("production").at(-1)).toBe("production_employee_documents");
    expect(requiredCategories(null).at(-1)).toBe("staff_letter");
    expect(requiredCategories("production")).toHaveLength(6);
  });
});

describe("the tracker", () => {
  it("merges complete and pending employees by name and counts what is on file", () => {
    expect(rows.map((r) => r.name)).toEqual(["Asha Kumar", "Bala Raj", "Meena Das", "Ravi Singh"]);
    expect(rows[0]).toMatchObject({ status: "complete", present: 6, required: 6, missing: [] });
    expect(rows[3]).toMatchObject({ status: "pending", present: 3, required: 6 });
    expect(buildTracker(undefined, 6)).toEqual([]);
  });

  it("searches name, code and department, every word having to match", () => {
    const find = (query: string) => filterTracker(rows, { ...NO_FILTERS, query }).map((r) => r.employeeCode);
    expect(find("ravi")).toEqual(["E002"]);
    expect(find("e003")).toEqual(["E003"]);
    expect(find("stitching")).toEqual(["E001", "E003"]);
    expect(find("stitching meena")).toEqual(["E003"]);
    expect(find("stitching ravi")).toEqual([]);
  });

  it("filters by status, department (including none) and a missing document", () => {
    const f = (patch: Partial<typeof NO_FILTERS>) =>
      filterTracker(rows, { ...NO_FILTERS, ...patch }).map((r) => r.employeeCode);
    expect(f({ status: "complete" })).toEqual(["E001"]);
    expect(f({ status: "pending" })).toEqual(["E004", "E003", "E002"]);
    expect(f({ department: "Cutting" })).toEqual(["E002"]);
    expect(f({ department: NO_DEPARTMENT })).toEqual(["E004"]);
    expect(f({ missing: "pan_card" })).toEqual(["E003", "E002"]);
    expect(f({ missing: "pan_card", department: "Stitching" })).toEqual(["E003"]);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, missing: "pan_card" })).toBe(true);
  });

  it("sorts by name, code and by how many documents are on file", () => {
    expect(sortTracker(rows, "name", "desc").map((r) => r.name)[0]).toBe("Ravi Singh");
    expect(sortTracker(rows, "code", "asc").map((r) => r.employeeCode)).toEqual(["E001", "E002", "E003", "E004"]);
    // fewest on file first: Ravi (3), then Meena and Bala (5), then Asha (6)
    expect(sortTracker(rows, "documents", "asc").map((r) => r.employeeCode)).toEqual(["E002", "E004", "E003", "E001"]);
  });

  it("summarises complete, pending, missing files and the most-missing document", () => {
    const s = summarizeTracker(rows);
    expect(s).toMatchObject({ total: 4, complete: 1, pending: 3, percent: 25, missingFiles: 5 });
    expect(s.mostMissing).toEqual({ value: "aadhaar_card", label: "Aadhaar Card", count: 2 });
    expect(summarizeTracker([])).toMatchObject({ total: 0, percent: 100, mostMissing: null });
  });

  it("lists the missing documents as filter choices with how many people lack each", () => {
    expect(missingOptions(rows)).toEqual([
      { value: "aadhaar_card", label: "Aadhaar Card", count: 2 },
      { value: "bank_passbook", label: "Bank Passbook", count: 1 },
      { value: "pan_card", label: "PAN Card", count: 2 },
    ]);
  });
});

describe("one employee's files", () => {
  const docs = [
    doc({ id: 1, category: "pan_card", uploadedAt: "2026-03-01T10:00:00Z" }),
    doc({ id: 2, category: "pan_card", uploadedAt: "2026-05-01T10:00:00Z" }),
    doc({ id: 3, category: "aadhaar_card", uploadedAt: null }),
  ];

  it("counts files per category and finds the newest upload", () => {
    expect(categoryStatus(docs, "pan_card")).toEqual({ count: 2, latest: "2026-05-01T10:00:00Z" });
    expect(categoryStatus(docs, "aadhaar_card")).toEqual({ count: 1, latest: null });
    expect(categoryStatus(docs, "bank_passbook")).toEqual({ count: 0, latest: null });
  });

  it("works out how many required documents are on file, by type", () => {
    const c = completion(docs, "staff");
    expect(c).toMatchObject({ present: 2, required: 6 });
    expect(c.missing).toEqual([
      "educational_certificate",
      "voter_id_or_birth_certificate",
      "bank_passbook",
      "staff_letter",
    ]);
    // a staff letter does not count for a production employee
    const production = completion([...docs, doc({ id: 4, category: "staff_letter" })], "production");
    expect(production.present).toBe(2);
    expect(production.missing).toContain("production_employee_documents");
  });
});

describe("uploads", () => {
  it("accepts a PDF, JPG or PNG within 10 MB", () => {
    expect(checkUpload({ name: "pan.pdf", size: 1000 })).toBeNull();
    expect(checkUpload({ name: "Scan.JPEG", size: 5 * 1024 * 1024 })).toBeNull();
    expect(checkUpload({ name: "a.png", size: 10 * 1024 * 1024 })).toBeNull();
  });

  it("explains why a file is refused", () => {
    expect(checkUpload({ name: "cv.docx", size: 1000 })).toContain("not a PDF, JPG or PNG");
    expect(checkUpload({ name: "noextension", size: 1000 })).toContain("not a PDF");
    expect(checkUpload({ name: "big.pdf", size: 10 * 1024 * 1024 + 1 })).toContain("10 MB");
    expect(checkUpload({ name: "empty.pdf", size: 0 })).toContain("empty");
  });

  it("spots a last working day before the joining date", () => {
    expect(lastDayBeforeJoining("2019-12-31", "2020-01-01")).toBe(true);
    expect(lastDayBeforeJoining("2020-01-01", "2020-01-01")).toBe(false);
    expect(lastDayBeforeJoining("2019-01-01", null)).toBe(false);
    expect(lastDayBeforeJoining("", "2020-01-01")).toBe(false);
  });
});
