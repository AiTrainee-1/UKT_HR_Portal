import EmployeeLayout from "@/components/EmployeeLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import Loader from "@/components/Loader";
import { EmployeeIdCard } from "@/components/EmployeeIdCard";
import { useAuth } from "@/contexts/AuthContext";
import { useGetEmployee, getGetEmployeeQueryKey } from "@/lib/api-client";
import {
  Phone, Mail, MapPin, Building, CreditCard, Calendar,
  User, AlertCircle, FileText, Clock, Droplet
} from "lucide-react";

interface ExtendedEmployee {
  id: number;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  salaryType: "monthly" | "weekly";
  salaryAmount?: number | null;
  status: "active" | "inactive";
  bankName?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  idProof?: string | null;
  pfNumber?: string | null;
  esiNumber?: string | null;
  address?: string | null;
  joinDate?: string | null;
  hasPassword?: boolean;
  createdAt: string;
  designation?: string;
  bloodGroup?: string;
  salaryEffectiveDate?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  emergencyRelation?: string;
  shift?: string;
  reportingManager?: string;
  workLocation?: string;
  offerLetterUrl?: string;
  contractUrl?: string;
  idProofUrl?: string;
}

export default function EmployeeProfile() {
  const { user } = useAuth();
  const empId = user?.employeeId;

  const { data: rawEmployee, isLoading } = useGetEmployee(empId ?? 0, {
    query: { enabled: !!empId, queryKey: getGetEmployeeQueryKey(empId ?? 0) }
  });

  const employee = rawEmployee as ExtendedEmployee | undefined;

  if (isLoading) {
    return (
      <EmployeeLayout>
        <div className="flex items-center justify-center min-h-[calc(100vh-200px)]">
          <Loader />
        </div>
      </EmployeeLayout>
    );
  }

  if (!employee) {
    return (
      <EmployeeLayout>
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <p>Profile not available</p>
        </div>
      </EmployeeLayout>
    );
  }

  return (
    <EmployeeLayout>
      <div className="max-w-3xl space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-black">My Profile</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Your employment details</p>
          </div>
          <EmployeeIdCard
            employee={{
              firstName: employee.firstName,
              lastName: employee.lastName,
              employeeCode: employee.employeeCode,
              departmentName: employee.departmentName ?? undefined,
              email: employee.email ?? undefined,
              phone: employee.phone ?? undefined,
              joinDate: employee.joinDate ?? undefined,
              status: employee.status ?? undefined,
              bloodGroup: employee.bloodGroup,
              emergencyContact: employee.emergencyContact,
            }}
            companyName="UK TEXTILES"
          />
        </div>

        {/* Identity card */}
        <Card className="bg-sidebar text-sidebar-foreground border-sidebar-border">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 rounded-full bg-sidebar-accent flex items-center justify-center flex-shrink-0">
                <User size={28} className="text-sidebar-primary" />
              </div>
              <div className="flex-1">
                <h3 className="text-xl font-black">{employee.firstName} {employee.lastName}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Badge className="bg-sidebar-primary text-sidebar-primary-foreground font-mono text-xs">
                    {employee.employeeCode}
                  </Badge>
                  <span className="text-sidebar-foreground/60 text-sm">{employee.departmentName}</span>
                  <Badge
                    variant={employee.status === "active" ? "default" : "secondary"}
                    className={employee.status === "active" ? "bg-green-600 text-white" : ""}
                  >
                    {employee.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 mt-2 flex-wrap">
                  {employee.joinDate && (
                    <p className="text-sidebar-foreground/50 text-xs flex items-center gap-1">
                      <Calendar size={12} />
                      Joined {new Date(employee.joinDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                    </p>
                  )}
                  {employee.designation && (
                    <p className="text-sidebar-foreground/50 text-xs flex items-center gap-1">
                      <User size={12} />
                      {employee.designation}
                    </p>
                  )}
                  {employee.bloodGroup && (
                    <p className="text-sidebar-foreground/50 text-xs flex items-center gap-1">
                      <Droplet size={12} />
                      {employee.bloodGroup}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Contact */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-3">
                <Phone size={15} className="text-muted-foreground flex-shrink-0" />
                <span>{employee.phone}</span>
              </div>
              <div className="flex items-center gap-3">
                <Mail size={15} className="text-muted-foreground flex-shrink-0" />
                <span className="break-all">{employee.email}</span>
              </div>
              {employee.address && (
                <div className="flex items-start gap-3">
                  <MapPin size={15} className="text-muted-foreground flex-shrink-0 mt-0.5" />
                  <span>{employee.address}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Salary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Salary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Type</span>
                <span className="capitalize font-medium">{employee.salaryType}</span>
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-black text-xl">₹{Number(employee.salaryAmount ?? 0).toLocaleString("en-IN")}</span>
              </div>
              {employee.salaryEffectiveDate && (
                <>
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Effective from</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(employee.salaryEffectiveDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    </span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Banking */}
          {(employee.bankName || employee.bankAccount) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Bank Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {employee.bankName && (
                  <div className="flex items-center gap-3">
                    <Building size={15} className="text-muted-foreground" />
                    <span>{employee.bankName}</span>
                  </div>
                )}
                {employee.bankAccount && (
                  <div className="flex items-center gap-3">
                    <CreditCard size={15} className="text-muted-foreground" />
                    <span className="font-mono">{employee.bankAccount}</span>
                  </div>
                )}
                {employee.bankIfsc && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">IFSC</span>
                    <span className="font-mono">{employee.bankIfsc}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Compliance */}
          {(employee.pfNumber || employee.esiNumber) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Compliance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {employee.pfNumber && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PF Number</span>
                    <span className="font-mono">{employee.pfNumber}</span>
                  </div>
                )}
                {employee.esiNumber && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ESI Number</span>
                    <span className="font-mono">{employee.esiNumber}</span>
                  </div>
                )}
                {employee.idProof && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ID Proof</span>
                    <span>{employee.idProof}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Emergency Contact */}
          {(employee.emergencyContact || employee.emergencyPhone) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Emergency Contact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {employee.emergencyContact && (
                  <div className="flex items-center gap-3">
                    <AlertCircle size={15} className="text-muted-foreground flex-shrink-0" />
                    <span>{employee.emergencyContact}</span>
                  </div>
                )}
                {employee.emergencyPhone && (
                  <div className="flex items-center gap-3">
                    <Phone size={15} className="text-muted-foreground flex-shrink-0" />
                    <span>{employee.emergencyPhone}</span>
                  </div>
                )}
                {employee.emergencyRelation && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Relation</span>
                    <span className="capitalize">{employee.emergencyRelation}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Work Info */}
          {(employee.shift || employee.reportingManager || employee.workLocation) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Work Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {employee.reportingManager && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Reports to</span>
                    <span className="font-medium">{employee.reportingManager}</span>
                  </div>
                )}
                {employee.shift && (
                  <>
                    <Separator />
                    <div className="flex items-center gap-3">
                      <Clock size={15} className="text-muted-foreground flex-shrink-0" />
                      <span>{employee.shift}</span>
                    </div>
                  </>
                )}
                {employee.workLocation && (
                  <>
                    <Separator />
                    <div className="flex items-center gap-3">
                      <MapPin size={15} className="text-muted-foreground flex-shrink-0" />
                      <span>{employee.workLocation}</span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Documents */}
          {(employee.offerLetterUrl || employee.contractUrl || employee.idProofUrl) && (
            <Card className="md:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Documents</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {[
                    { label: "Offer Letter", url: employee.offerLetterUrl },
                    { label: "Contract", url: employee.contractUrl },
                    { label: "ID Proof", url: employee.idProofUrl },
                  ]
                    .filter(d => d.url)
                    .map(doc => (
                      <a
                        key={doc.label}
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 p-3 rounded-lg border text-sm hover:bg-muted transition-colors"
                      >
                        <FileText size={15} className="text-muted-foreground flex-shrink-0" />
                        <span>{doc.label}</span>
                      </a>
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </EmployeeLayout>
  );
}