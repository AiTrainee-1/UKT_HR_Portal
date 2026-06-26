import { useParams, useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useGetEmployee, useListSalaryRecords, getGetEmployeeQueryKey } from "@/lib/api-client";
import { ArrowLeft, Phone, Mail, MapPin, CreditCard, Building, Calendar } from "lucide-react";
import Loader from "@/components/Loader";

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const empId = Number(id);

  const { data: employee, isLoading } = useGetEmployee(empId, {
    query: { enabled: !!empId, queryKey: getGetEmployeeQueryKey(empId) }
  });
  const { data: salaryRecords } = useListSalaryRecords({ employeeId: empId });

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

  return (
    <HrLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")} data-testid="button-back">
            <ArrowLeft size={18} />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-2xl font-black">{employee.firstName} {employee.lastName}</h2>
              <Badge variant="outline" className="font-mono">{employee.employeeCode}</Badge>
              <Badge variant={employee.status === "active" ? "default" : "secondary"}
                className={employee.status === "active" ? "bg-green-100 text-green-800" : ""}>
                {employee.status}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm mt-0.5">{employee.departmentName} · Joined {employee.joinDate ? new Date(employee.joinDate).toLocaleDateString("en-IN") : "N/A"}</p>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Contact */}
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Contact</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-3"><Phone size={15} className="text-muted-foreground" /><span>{employee.phone}</span></div>
              <div className="flex items-center gap-3"><Mail size={15} className="text-muted-foreground" /><span>{employee.email}</span></div>
              {employee.address && <div className="flex items-start gap-3"><MapPin size={15} className="text-muted-foreground mt-0.5" /><span>{employee.address}</span></div>}
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
