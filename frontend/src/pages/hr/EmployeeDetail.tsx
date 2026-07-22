import { useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import html2canvas from "html2canvas";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  useGetEmployee, useListSalaryRecords, useListLeaveRequests, getGetEmployeeQueryKey,
} from "@/lib/api-client";
import {
  useIdCards, useAttendanceEmployeeHistory, previewDocumentPdf, downloadDocumentPdf,
  useEmployeeDocuments, EMPLOYEE_DOCUMENT_CATEGORIES,
} from "@/lib/api-client/custom-hooks";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import {
  StaffCardFront, StaffCardBack, ProductionCardFront, ProductionCardBack, useQrCodes,
} from "@/components/idcard/IdCardViews";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft, Phone, Mail, MapPin, CreditCard, Building, Calendar, Droplets,
  ShieldAlert, Cake, Download, CalendarCheck, CalendarX, CalendarDays, Briefcase, User,
  FileSignature, Award, Eye, FolderOpen, ExternalLink,
} from "lucide-react";
import Loader from "@/components/Loader";
import EmployeeAvatar from "@/components/EmployeeAvatar";

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const empId = Number(id);

  const { data: employee, isLoading } = useGetEmployee(empId, {
    query: { enabled: !!empId, queryKey: getGetEmployeeQueryKey(empId) }
  });
  const { data: salaryRecords } = useListSalaryRecords({ employeeId: empId });
  const { data: idCards } = useIdCards(empId ? [empId] : []);
  const idCard = idCards?.[0];
  const qrs = useQrCodes(idCard ? [idCard] : []);

  const now = new Date();
  const { data: attendanceMonth } = useAttendanceEmployeeHistory(
    empId || null, now.getMonth() + 1, now.getFullYear(),
  );
  const { data: leaveRequests } = useListLeaveRequests({ employeeId: empId } as never);
  const { data: uploadedDocuments } = useEmployeeDocuments(empId || null);

  const { token } = useAuth();
  const cardRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [lastWorkingDay, setLastWorkingDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [offerLetterBusy, setOfferLetterBusy] = useState<"preview" | "download" | null>(null);
  const [experienceLetterBusy, setExperienceLetterBusy] = useState<"preview" | "download" | null>(null);

  const handleOfferLetter = async (mode: "preview" | "download") => {
    setOfferLetterBusy(mode);
    try {
      const url = `/api/employees/${empId}/offer-letter/pdf`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate Offer Letter", variant: "destructive" });
    } finally {
      setOfferLetterBusy(null);
    }
  };

  const handleExperienceLetter = async (mode: "preview" | "download") => {
    setExperienceLetterBusy(mode);
    try {
      const url = `/api/employees/${empId}/experience-letter/pdf?lastWorkingDate=${lastWorkingDay}`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate Experience Letter", variant: "destructive" });
    } finally {
      setExperienceLetterBusy(null);
    }
  };

  const handleDownloadIdCard = async () => {
    if (!cardRef.current || !employee) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: "#ffffff",
        scale: 3,
        useCORS: true,
      });
      const link = document.createElement("a");
      link.download = `ID-Card-${employee.employeeCode}-${employee.firstName}${employee.lastName}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast({ title: "ID card downloaded" });
    } catch {
      toast({ title: "Failed to download ID card", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading) {
    return (
      <HrLayout>
        <div className="flex items-center justify-center min-h-[calc(100vh-140px)]">
          <Loader />
        </div>
      </HrLayout>
    );
  }

  if (!employee) {
    return (
      <HrLayout>
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <p className="text-lg font-semibold">Employee not found</p>
          <Button className="mt-4" onClick={() => navigate("/hr/employees")}>Back to List</Button>
        </div>
      </HrLayout>
    );
  }

  // Lifetime approved leave days (all statuses fetched; filter client-side)
  const approvedLeaveDays = (leaveRequests ?? [])
    .filter((r) => r.status === "approved")
    .reduce((sum, r) => sum + Number(r.totalDays ?? 0), 0);

  const workingDaysThisMonth =
    (attendanceMonth?.totalPresent ?? 0) +
    (attendanceMonth?.totalAbsent ?? 0) +
    (attendanceMonth?.summary?.onLeave ?? 0);

  return (
    <HrLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")} data-testid="button-back">
            <ArrowLeft size={18} />
          </Button>
          <EmployeeAvatar photoUrl={employee.photoUrl} name={`${employee.firstName} ${employee.lastName}`} size={56} />
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-2xl font-black">{employee.firstName} {employee.lastName}</h2>
              <Badge variant="outline" className="font-mono">{employee.employeeCode}</Badge>
              <Badge variant={employee.status === "active" ? "default" : "secondary"}
                className={employee.status === "active" ? "bg-green-100 text-green-800" : ""}>
                {employee.status}
              </Badge>
              {employee.branchName && (
                <Badge variant="outline" className="gap-1.5 text-teal-700 border-teal-200 bg-teal-50">
                  <Building size={11} /> {employee.branchName}
                  {employee.unitCode && (
                    <span className="text-[10px] font-mono font-black text-teal-800">{employee.unitCode}</span>
                  )}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm mt-0.5">
              {employee.departmentName}
              {employee.designationTitle ? ` · ${employee.designationTitle}` : ""} · Joined{" "}
              {employee.joinDate ? new Date(employee.joinDate).toLocaleDateString("en-IN") : "N/A"}
            </p>
          </div>
          <Button className="gap-2" onClick={handleDownloadIdCard} disabled={downloading || !idCard}>
            <Download size={15} />
            {downloading ? "Preparing…" : "Download ID Card"}
          </Button>
        </div>

        {/* This-month attendance snapshot */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Working Days (This Month)", value: workingDaysThisMonth, icon: CalendarDays, cls: "text-gray-900", iconCls: "bg-gray-700" },
            { label: "Present Days", value: attendanceMonth?.totalPresent ?? "—", icon: CalendarCheck, cls: "text-green-700", iconCls: "bg-green-600" },
            { label: "Absent Days", value: attendanceMonth?.totalAbsent ?? "—", icon: CalendarX, cls: "text-red-600", iconCls: "bg-red-500" },
            { label: "Total Leave Days (Lifetime)", value: approvedLeaveDays, icon: Calendar, cls: "text-purple-700", iconCls: "bg-purple-600" },
          ].map(({ label, value, icon: Icon, cls, iconCls }) => (
            <Card key={label} className="border">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
                  <div className={`p-1.5 rounded-lg ${iconCls}`}>
                    <Icon size={14} className="text-white" />
                  </div>
                </div>
                <p className={`text-3xl font-black leading-none ${cls}`}>{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Personal Information */}
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Personal Information</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-3"><User size={15} className="text-muted-foreground" /><span className="capitalize">{employee.gender ?? "—"}</span></div>
              <div className="flex items-center gap-3"><Cake size={15} className="text-muted-foreground" /><span>{employee.dateOfBirth ? new Date(employee.dateOfBirth).toLocaleDateString("en-IN") : "—"}</span></div>
              <div className="flex items-center gap-3">
                <Droplets size={15} className={employee.bloodGroup ? "text-red-400" : "text-muted-foreground"} />
                <span className={employee.bloodGroup ? "font-semibold" : "text-muted-foreground"}>{employee.bloodGroup ?? "Not recorded"}</span>
              </div>
              <div className="flex items-center gap-3"><Briefcase size={15} className="text-muted-foreground" /><span className="capitalize">{employee.employmentType ?? "—"}</span></div>
              <div className="flex items-center gap-3"><Calendar size={15} className="text-muted-foreground" /><span>Joined {employee.joinDate ? new Date(employee.joinDate).toLocaleDateString("en-IN") : "N/A"}</span></div>
            </CardContent>
          </Card>

          {/* Contact */}
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Contact</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-3"><Phone size={15} className="text-muted-foreground" /><span>{employee.phone}</span></div>
              <div className="flex items-center gap-3"><Mail size={15} className="text-muted-foreground" /><span>{employee.email}</span></div>
              {employee.address && <div className="flex items-start gap-3"><MapPin size={15} className="text-muted-foreground mt-0.5" /><span>{employee.address}</span></div>}
              {employee.emergencyContact && <div className="flex items-center gap-3"><ShieldAlert size={15} className="text-amber-400" /><span>{employee.emergencyContact}</span></div>}
            </CardContent>
          </Card>

          {/* Salary */}
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Salary</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Type</span><span className="capitalize font-medium">{employee.salaryType}</span></div>
              <Separator />
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-black text-lg">₹{Number(employee.salaryAmount ?? 0).toLocaleString("en-IN")}</span></div>
            </CardContent>
          </Card>

          {/* Bank */}
          {(employee.bankName || employee.bankAccount) && (
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Banking</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {employee.bankName && <div className="flex items-center gap-3"><Building size={15} className="text-muted-foreground" /><span>{employee.bankName}</span></div>}
                {employee.bankAccount && <div className="flex items-center gap-3"><CreditCard size={15} className="text-muted-foreground" /><span className="font-mono">{employee.bankAccount}</span></div>}
                {employee.bankIfsc && <div className="flex items-center gap-3"><span className="text-muted-foreground text-xs w-4">IFSC</span><span className="font-mono">{employee.bankIfsc}</span></div>}
              </CardContent>
            </Card>
          )}

          {/* Compliance */}
          {(employee.pfNumber || employee.esiNumber) && (
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Compliance</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {employee.pfNumber && <div className="flex justify-between"><span className="text-muted-foreground">PF Number</span><span className="font-mono">{employee.pfNumber}</span></div>}
                {employee.esiNumber && <div className="flex justify-between"><span className="text-muted-foreground">ESI Number</span><span className="font-mono">{employee.esiNumber}</span></div>}
                {employee.idProof && <div className="flex justify-between"><span className="text-muted-foreground">ID Proof</span><span>{employee.idProof}</span></div>}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Documents — Offer Letter / Experience Letter generation */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <FileSignature size={15} />Documents
            </CardTitle>
          </CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-5">
            <div className="space-y-2">
              <p className="text-sm font-semibold flex items-center gap-2"><FileSignature size={14} className="text-emerald-700" /> Offer Letter</p>
              <p className="text-xs text-muted-foreground">Generated from this employee's current designation, department, and salary.</p>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleOfferLetter("preview")} disabled={offerLetterBusy !== null}>
                  <Eye size={14} />{offerLetterBusy === "preview" ? "Generating…" : "Preview"}
                </Button>
                <Button size="sm" className="gap-1.5" onClick={() => handleOfferLetter("download")} disabled={offerLetterBusy !== null}>
                  <Download size={14} />{offerLetterBusy === "download" ? "Generating…" : "Download"}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold flex items-center gap-2"><Award size={14} className="text-emerald-700" /> Experience Letter</p>
              <div className="space-y-1.5">
                <Label className="text-xs">Last Working Day</Label>
                <Input type="date" className="h-8 w-44" value={lastWorkingDay} onChange={(e) => setLastWorkingDay(e.target.value)} />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleExperienceLetter("preview")} disabled={experienceLetterBusy !== null}>
                  <Eye size={14} />{experienceLetterBusy === "preview" ? "Generating…" : "Preview"}
                </Button>
                <Button size="sm" className="gap-1.5" onClick={() => handleExperienceLetter("download")} disabled={experienceLetterBusy !== null}>
                  <Download size={14} />{experienceLetterBusy === "download" ? "Generating…" : "Download"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Uploaded Documents — read-only here; upload/delete happens on the dedicated Documents page */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <FolderOpen size={15} />Uploaded Documents
            </CardTitle>
            <Link href="/hr/recruitment/documents" className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
              Manage <ExternalLink size={12} />
            </Link>
          </CardHeader>
          <CardContent>
            {!uploadedDocuments || uploadedDocuments.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No documents uploaded yet. Use the Documents page to add PAN, Aadhaar, certificates, and more.
              </p>
            ) : (
              <div className="grid sm:grid-cols-2 gap-2">
                {EMPLOYEE_DOCUMENT_CATEGORIES.map(({ value, label }) => {
                  const files = uploadedDocuments.filter(d => d.category === value);
                  if (files.length === 0) return null;
                  return (
                    <div key={value} className="rounded-lg border p-3">
                      <p className="text-xs font-semibold text-gray-700 mb-1.5">{label} ({files.length})</p>
                      <div className="space-y-1">
                        {files.map(doc => (
                          <div key={doc.id} className="flex items-center gap-2 text-xs">
                            <span className="flex-1 truncate text-muted-foreground">{doc.originalFilename}</span>
                            <button
                              onClick={() => previewDocumentPdf(doc.fileUrl, () => token)}
                              className="p-1 rounded hover:bg-gray-100 text-gray-500"
                              title="View"
                            >
                              <Eye size={12} />
                            </button>
                            <button
                              onClick={() => downloadDocumentPdf(doc.fileUrl, () => token)}
                              className="p-1 rounded hover:bg-gray-100 text-gray-500"
                              title="Download"
                            >
                              <Download size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Employee ID Card — view only, download is the only action */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <CreditCard size={15} />Employee ID Card
            </CardTitle>
          </CardHeader>
          <CardContent>
            {idCard ? (
              <div ref={cardRef} className="inline-flex gap-4 flex-wrap bg-white p-2">
                {idCard.employmentType === "production" ? (
                  <>
                    <ProductionCardFront card={idCard} />
                    <ProductionCardBack card={idCard} qr={qrs[idCard.code]} />
                  </>
                ) : (
                  <>
                    <StaffCardFront card={idCard} />
                    <StaffCardBack card={idCard} qr={qrs[idCard.code]} />
                  </>
                )}
              </div>
            ) : (
              <p className="text-center py-8 text-muted-foreground text-sm">Loading ID card…</p>
            )}
          </CardContent>
        </Card>

        {/* Salary History */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2"><Calendar size={15} />Salary History</CardTitle></CardHeader>
          <CardContent className="p-0">
            {salaryRecords && salaryRecords.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Period</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="pr-4">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salaryRecords.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell className="pl-4 font-medium">{rec.month}/{rec.year}</TableCell>
                      <TableCell className="capitalize text-muted-foreground text-sm">{rec.type}</TableCell>
                      <TableCell className="font-semibold">₹{Number(rec.amount).toLocaleString("en-IN")}</TableCell>
                      <TableCell>
                        <Badge variant={rec.status === "paid" ? "default" : "secondary"}
                          className={rec.status === "paid" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
                          {rec.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4 text-muted-foreground text-sm">{rec.notes ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-center py-8 text-muted-foreground text-sm">No salary records yet</p>
            )}
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}
