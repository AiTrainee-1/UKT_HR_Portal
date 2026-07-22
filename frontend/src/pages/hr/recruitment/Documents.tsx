import { useEffect, useRef, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useListEmployees } from "@/lib/api-client";
import {
  useEmployeeDocuments, useUploadEmployeeDocument, useDeleteEmployeeDocument,
  useListResignations, useDocumentCompletionStats, previewDocumentPdf, downloadDocumentPdf,
  EMPLOYEE_DOCUMENT_CATEGORIES,
  type EmployeeDocumentCategory, type EmployeeDocumentItem,
} from "@/lib/api-client/custom-hooks";
import {
  FolderOpen, Search, Users, ChevronLeft, ChevronRight, Upload, Eye, Download, Trash2, Loader2,
  CreditCard, Fingerprint, GraduationCap, Vote, Wallet, FileSignature, FileClock,
  FileMinus, FileBadge, Factory, CheckCircle2, AlertTriangle, X, type LucideIcon,
} from "lucide-react";

const CATEGORY_ICONS: Record<EmployeeDocumentCategory, LucideIcon> = {
  pan_card: CreditCard,
  aadhaar_card: Fingerprint,
  educational_certificate: GraduationCap,
  voter_id_or_birth_certificate: Vote,
  bank_passbook: Wallet,
  offer_letter: FileSignature,
  experience_letter: FileClock,
  resignation_letter: FileMinus,
  staff_letter: FileBadge,
  production_employee_documents: Factory,
};

// The system already generates Offer/Experience/Resignation letters on demand
// (Company Documents Settings templates) — no reason to also let HR upload
// manual copies of them here. Extra Documents keeps only the categories that
// have no generator: ID proofs and scanned/signed paperwork.
const EXTRA_DOCUMENT_CATEGORIES = EMPLOYEE_DOCUMENT_CATEGORIES.filter(
  c => c.value !== "offer_letter" && c.value !== "experience_letter" && c.value !== "resignation_letter",
);

const PAGE_SIZE = 8;

function ListPagination({
  page, totalCount, onChange,
}: {
  page: number;
  totalCount: number;
  onChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (totalCount <= PAGE_SIZE) return null;

  return (
    <div className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between border-t border-gray-50">
      <p className="text-xs text-gray-400">
        Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationPrevious
          href="#"
          className={page === 1 ? "pointer-events-none opacity-50" : undefined}
          onClick={(e) => { e.preventDefault(); if (page > 1) onChange(page - 1); }}
        />
        <PaginationContent>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <PaginationItem key={p}>
              <PaginationLink href="#" isActive={p === page} onClick={(e) => { e.preventDefault(); onChange(p); }}>
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}
        </PaginationContent>
        <PaginationNext
          href="#"
          className={page === totalPages ? "pointer-events-none opacity-50" : undefined}
          onClick={(e) => { e.preventDefault(); if (page < totalPages) onChange(page + 1); }}
        />
      </Pagination>
    </div>
  );
}

export default function Documents() {
  const { toast } = useToast();
  const { token } = useAuth();
  const [tab, setTab] = useState<"staff" | "production">("staff");
  const [search, setSearch] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [docTab, setDocTab] = useState<"letters" | "extra">("letters");
  const [activeCategory, setActiveCategory] = useState<EmployeeDocumentCategory | null>(null);
  const [panel, setPanel] = useState<"search" | "pending" | "uploaded">("search");
  const [searchPage, setSearchPage] = useState(1);
  const [pendingPage, setPendingPage] = useState(1);
  const [uploadedPage, setUploadedPage] = useState(1);

  const { data: employees, isLoading: employeesLoading } = useListEmployees(
    search.trim() ? { search: search.trim() } : undefined,
  );
  const matchingEmployees = (employees ?? []).filter(e => {
    const isProduction = e.employmentType === "production";
    return tab === "production" ? isProduction : !isProduction;
  });
  const pagedMatchingEmployees = matchingEmployees.slice((searchPage - 1) * PAGE_SIZE, searchPage * PAGE_SIZE);
  const selectedEmployee = employees?.find(e => e.id === selectedEmployeeId) ?? null;

  const { data: stats } = useDocumentCompletionStats(tab);
  const pagedPendingEmployees = (stats?.pendingEmployees ?? []).slice((pendingPage - 1) * PAGE_SIZE, pendingPage * PAGE_SIZE);
  const pagedUploadedEmployees = (stats?.uploadedEmployees ?? []).slice((uploadedPage - 1) * PAGE_SIZE, uploadedPage * PAGE_SIZE);

  useEffect(() => { setSearchPage(1); }, [search, tab]);
  useEffect(() => { setPendingPage(1); setUploadedPage(1); }, [tab]);

  function openEmployee(employeeId: number, initialDocTab: "letters" | "extra" = "letters") {
    setSelectedEmployeeId(employeeId);
    setDocTab(initialDocTab);
    setPanel("search");
  }

  const { data: documents } = useEmployeeDocuments(selectedEmployeeId);
  const countByCategory = (documents ?? []).reduce<Record<string, number>>((acc, d) => {
    acc[d.category] = (acc[d.category] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <HrLayout>
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
            <FolderOpen size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Documents</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              View generated letters and manage every employee's extra documents.
            </p>
          </div>
        </div>

        {!selectedEmployee ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <PillTabs
                items={[
                  { value: "staff", label: "Staff" },
                  { value: "production", label: "Production" },
                ]}
                value={tab}
                onChange={(v) => { setTab(v as "staff" | "production"); setPanel("search"); }}
              />
              <div className="relative ml-auto">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by Employee Code or name…"
                  className="pl-8 w-72 h-9"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setPanel(v => v === "uploaded" ? "search" : "uploaded")} className="text-left">
                <Card className={`border-0 shadow-sm hover:shadow-md transition-shadow ${panel === "uploaded" ? "ring-2 ring-emerald-400" : ""}`}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                      <CheckCircle2 size={18} className="text-emerald-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-2xl font-black text-gray-900 leading-none">{stats?.uploadedCount ?? "—"}</p>
                      <p className="text-xs text-gray-500 mt-1">Documents Uploaded</p>
                    </div>
                    <ChevronRight size={16} className={`text-gray-300 transition-transform ${panel === "uploaded" ? "rotate-90" : ""}`} />
                  </CardContent>
                </Card>
              </button>
              <button onClick={() => setPanel(v => v === "pending" ? "search" : "pending")} className="text-left">
                <Card className={`border-0 shadow-sm hover:shadow-md transition-shadow ${panel === "pending" ? "ring-2 ring-amber-400" : ""}`}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
                      <AlertTriangle size={18} className="text-amber-600" />
                    </div>
                    <div className="flex-1">
                      <p className="text-2xl font-black text-gray-900 leading-none">{stats?.pendingCount ?? "—"}</p>
                      <p className="text-xs text-gray-500 mt-1">Documents Pending</p>
                    </div>
                    <ChevronRight size={16} className={`text-gray-300 transition-transform ${panel === "pending" ? "rotate-90" : ""}`} />
                  </CardContent>
                </Card>
              </button>
            </div>

            {panel === "uploaded" ? (
              <Card className="border-0 shadow-sm">
                <CardContent className="p-0">
                  <div className="flex items-center justify-between px-5 py-3 border-b border-gray-50">
                    <p className="text-sm font-semibold text-gray-700">
                      {stats?.uploadedCount ?? 0} {tab} employee{stats?.uploadedCount === 1 ? "" : "s"} with all documents on file
                    </p>
                    <button onClick={() => setPanel("search")} className="p-1 rounded-md text-gray-400 hover:bg-gray-100">
                      <X size={14} />
                    </button>
                  </div>
                  {(stats?.uploadedEmployees ?? []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                      <AlertTriangle size={32} className="opacity-30 mb-2" />
                      <p className="text-sm">No {tab} employees have completed their documents yet.</p>
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-gray-50">
                        {pagedUploadedEmployees.map(emp => (
                          <button
                            key={emp.id}
                            onClick={() => openEmployee(emp.id, "extra")}
                            className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-50/70 transition-colors"
                          >
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                              {emp.name.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-gray-900">{emp.name}</p>
                              <p className="text-xs text-gray-400">{emp.employeeCode}{emp.departmentName ? ` · ${emp.departmentName}` : ""}</p>
                            </div>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700">Complete</span>
                          </button>
                        ))}
                      </div>
                      <ListPagination page={uploadedPage} totalCount={stats?.uploadedEmployees.length ?? 0} onChange={setUploadedPage} />
                    </>
                  )}
                </CardContent>
              </Card>
            ) : panel === "pending" ? (
              <Card className="border-0 shadow-sm">
                <CardContent className="p-0">
                  <div className="flex items-center justify-between px-5 py-3 border-b border-gray-50">
                    <p className="text-sm font-semibold text-gray-700">
                      {stats?.pendingCount ?? 0} {tab} employee{stats?.pendingCount === 1 ? "" : "s"} with missing documents
                    </p>
                    <button onClick={() => setPanel("search")} className="p-1 rounded-md text-gray-400 hover:bg-gray-100">
                      <X size={14} />
                    </button>
                  </div>
                  {(stats?.pendingEmployees ?? []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                      <CheckCircle2 size={32} className="opacity-30 mb-2" />
                      <p className="text-sm">Every {tab} employee has all required documents on file.</p>
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-gray-50">
                        {pagedPendingEmployees.map(emp => (
                          <button
                            key={emp.id}
                            onClick={() => openEmployee(emp.id, "extra")}
                            className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-50/70 transition-colors"
                          >
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                              {emp.name.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-gray-900">{emp.name}</p>
                              <p className="text-xs text-gray-400">{emp.employeeCode}{emp.departmentName ? ` · ${emp.departmentName}` : ""}</p>
                            </div>
                            <div className="flex flex-wrap gap-1 justify-end max-w-[45%]">
                              {emp.missingCategories.slice(0, 2).map(c => (
                                <span key={c.value} className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700">
                                  {c.label}
                                </span>
                              ))}
                              {emp.missingCategories.length > 2 && (
                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-gray-50 text-gray-500">
                                  +{emp.missingCategories.length - 2} more
                                </span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                      <ListPagination page={pendingPage} totalCount={stats?.pendingEmployees.length ?? 0} onChange={setPendingPage} />
                    </>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="border-0 shadow-sm">
                <CardContent className="p-0">
                  {employeesLoading ? (
                    <div className="flex items-center justify-center py-16 text-gray-400">
                      <Loader2 size={20} className="animate-spin mr-2" /> Loading employees…
                    </div>
                  ) : !search.trim() ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                      <Users size={32} className="opacity-30 mb-2" />
                      <p className="text-sm">Search for an employee by code or name to view their documents.</p>
                    </div>
                  ) : matchingEmployees.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                      <p className="text-sm">No {tab} employees match "{search}".</p>
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-gray-50">
                        {pagedMatchingEmployees.map(emp => (
                          <button
                            key={emp.id}
                            onClick={() => openEmployee(emp.id!)}
                            className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-50/70 transition-colors"
                          >
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                              {emp.firstName?.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-gray-900">{emp.firstName} {emp.lastName}</p>
                              <p className="text-xs text-gray-400">{emp.employeeCode}{emp.departmentName ? ` · ${emp.departmentName}` : ""}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                      <ListPagination page={searchPage} totalCount={matchingEmployees.length} onChange={setSearchPage} />
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSelectedEmployeeId(null)}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
              >
                <ChevronLeft size={18} />
              </button>
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
                {selectedEmployee.firstName?.charAt(0)}
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900">{selectedEmployee.firstName} {selectedEmployee.lastName}</p>
                <p className="text-xs text-gray-400">
                  {selectedEmployee.employeeCode}
                  {selectedEmployee.departmentName ? ` · ${selectedEmployee.departmentName}` : ""}
                </p>
              </div>
              <div className="ml-auto">
                <PillTabs
                  items={[
                    { value: "letters", label: "Letters" },
                    { value: "extra", label: "Extra Documents" },
                  ]}
                  value={docTab}
                  onChange={(v) => setDocTab(v as "letters" | "extra")}
                />
              </div>
            </div>

            {docTab === "letters" ? (
              <LettersTab employeeId={selectedEmployee.id!} token={token} toast={toast} />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {EXTRA_DOCUMENT_CATEGORIES.map(({ value, label }) => {
                  const Icon = CATEGORY_ICONS[value];
                  const count = countByCategory[value] ?? 0;
                  return (
                    <button key={value} onClick={() => setActiveCategory(value)} className="text-left">
                      <Card className="border-0 shadow-sm hover:shadow-md transition-shadow h-full">
                        <CardContent className="p-4 flex flex-col gap-2">
                          <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center">
                            <Icon size={16} className="text-indigo-600" />
                          </div>
                          <p className="text-sm font-semibold text-gray-800 leading-tight">{label}</p>
                          <p className="text-xs text-gray-400">
                            {count === 0 ? "No files" : `${count} file${count !== 1 ? "s" : ""}`}
                          </p>
                        </CardContent>
                      </Card>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {activeCategory && selectedEmployee && (
          <CategoryDialog
            employeeId={selectedEmployee.id!}
            category={activeCategory}
            documents={(documents ?? []).filter(d => d.category === activeCategory)}
            token={token}
            onClose={() => setActiveCategory(null)}
            toast={toast}
          />
        )}
      </div>
    </HrLayout>
  );
}

function LettersTab({
  employeeId, token, toast,
}: {
  employeeId: number;
  token: string | null;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [lastWorkingDay, setLastWorkingDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [offerBusy, setOfferBusy] = useState<"preview" | "download" | null>(null);
  const [experienceBusy, setExperienceBusy] = useState<"preview" | "download" | null>(null);
  const [resignationBusy, setResignationBusy] = useState<"preview" | "download" | null>(null);

  const { data: approvedResignations } = useListResignations("approved");
  const resignation = (approvedResignations ?? []).find(r => r.employeeId === employeeId) ?? null;

  const handleOfferLetter = async (mode: "preview" | "download") => {
    setOfferBusy(mode);
    try {
      const url = `/api/employees/${employeeId}/offer-letter/pdf`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate Offer Letter", variant: "destructive" });
    } finally {
      setOfferBusy(null);
    }
  };

  const handleExperienceLetter = async (mode: "preview" | "download") => {
    setExperienceBusy(mode);
    try {
      const url = `/api/employees/${employeeId}/experience-letter/pdf?lastWorkingDate=${lastWorkingDay}`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate Experience Letter", variant: "destructive" });
    } finally {
      setExperienceBusy(null);
    }
  };

  const handleResignationLetter = async (mode: "preview" | "download") => {
    if (!resignation) return;
    setResignationBusy(mode);
    try {
      const url = `/api/recruitment/resignations/${resignation.id}/pdf`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate Resignation Letter", variant: "destructive" });
    } finally {
      setResignationBusy(null);
    }
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center">
            <FileSignature size={16} className="text-indigo-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">Offer Letter</p>
            <p className="text-xs text-gray-400 mt-0.5">Generated from current designation, department, and salary.</p>
          </div>
          <div className="flex items-center gap-2 mt-auto pt-1">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleOfferLetter("preview")} disabled={offerBusy !== null}>
              <Eye size={14} />{offerBusy === "preview" ? "Generating…" : "Preview"}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => handleOfferLetter("download")} disabled={offerBusy !== null}>
              <Download size={14} />{offerBusy === "download" ? "Generating…" : "Download"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center">
            <FileClock size={16} className="text-indigo-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">Experience Letter</p>
            <div className="space-y-1 mt-2">
              <Label className="text-xs">Last Working Day</Label>
              <Input type="date" className="h-8" value={lastWorkingDay} onChange={(e) => setLastWorkingDay(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-auto pt-1">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleExperienceLetter("preview")} disabled={experienceBusy !== null}>
              <Eye size={14} />{experienceBusy === "preview" ? "Generating…" : "Preview"}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => handleExperienceLetter("download")} disabled={experienceBusy !== null}>
              <Download size={14} />{experienceBusy === "download" ? "Generating…" : "Download"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center">
            <FileMinus size={16} className="text-indigo-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">Resignation Letter</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {resignation
                ? "Acceptance letter for this employee's approved resignation."
                : "Available once this employee's resignation is approved."}
            </p>
          </div>
          <div className="flex items-center gap-2 mt-auto pt-1">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleResignationLetter("preview")} disabled={!resignation || resignationBusy !== null}>
              <Eye size={14} />{resignationBusy === "preview" ? "Generating…" : "Preview"}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => handleResignationLetter("download")} disabled={!resignation || resignationBusy !== null}>
              <Download size={14} />{resignationBusy === "download" ? "Generating…" : "Download"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CategoryDialog({
  employeeId, category, documents, token, onClose, toast,
}: {
  employeeId: number;
  category: EmployeeDocumentCategory;
  documents: EmployeeDocumentItem[];
  token: string | null;
  onClose: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const uploadMutation = useUploadEmployeeDocument();
  const deleteMutation = useDeleteEmployeeDocument();
  const label = EMPLOYEE_DOCUMENT_CATEGORIES.find(c => c.value === category)?.label ?? category;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await uploadMutation.mutateAsync({ employeeId, category, file });
      toast({ title: "Document uploaded", description: file.name });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Unknown error";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleView(doc: EmployeeDocumentItem) {
    try {
      await previewDocumentPdf(doc.fileUrl, () => token);
    } catch {
      toast({ title: "Failed to open document", variant: "destructive" });
    }
  }

  async function handleDownload(doc: EmployeeDocumentItem) {
    try {
      await downloadDocumentPdf(doc.fileUrl, () => token);
    } catch {
      toast({ title: "Failed to download document", variant: "destructive" });
    }
  }

  async function handleDelete(doc: EmployeeDocumentItem) {
    setBusyId(doc.id);
    try {
      await deleteMutation.mutateAsync(doc.id);
      toast({ title: "Document deleted" });
    } catch {
      toast({ title: "Failed to delete document", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {documents.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No files uploaded yet.</p>
          ) : (
            documents.map(doc => (
              <div key={doc.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm">
                <span className="flex-1 truncate">{doc.originalFilename}</span>
                <button onClick={() => handleView(doc)} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100" title="View">
                  <Eye size={14} />
                </button>
                <button onClick={() => handleDownload(doc)} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100" title="Download">
                  <Download size={14} />
                </button>
                <button
                  onClick={() => handleDelete(doc)}
                  disabled={busyId === doc.id}
                  className="p-1.5 rounded-md text-red-500 hover:bg-red-50 disabled:opacity-40"
                  title="Delete"
                >
                  {busyId === doc.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="gap-2">
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload File
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
