import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import Loader from "@/components/Loader";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { ActionTooltip } from "@/components/ui/action-tooltip";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  useListEmployees, useListDepartments, useDeleteEmployee, useUpdateEmployeeStatus,
  getListEmployeesQueryKey
} from "@/lib/api-client";
import { useListBranches, getListBranchesQueryKey } from "@/lib/api-client/custom-hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, UserCheck, UserX, Trash2, Eye, Pencil, UploadCloud } from "lucide-react";

export default function Employees() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"staff" | "production">("staff");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;

  const { data: rawEmployees, isLoading } = useListEmployees({
    departmentId: deptFilter !== "all" ? Number(deptFilter) : undefined,
    branchId: !isBranchScoped && branchFilter !== "all" ? Number(branchFilter) : undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
  });

  const staffCount = rawEmployees?.filter((e) => e.employmentType !== "production").length ?? 0;
  const productionCount = rawEmployees?.filter((e) => e.employmentType === "production").length ?? 0;

  const employees = rawEmployees?.filter((e) => {
    const isProduction = e.employmentType === "production";
    if (typeFilter === "production" ? !isProduction : isProduction) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.firstName?.toLowerCase().includes(q) ||
      e.lastName?.toLowerCase().includes(q) ||
      e.email?.toLowerCase().includes(q) ||
      e.phone?.includes(q) ||
      e.employeeCode?.toLowerCase().includes(q)
    );
  });
  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const deleteMutation = useDeleteEmployee();
  const statusMutation = useUpdateEmployeeStatus();

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const totalEmployees = employees?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalEmployees / PAGE_SIZE));
  const paginatedEmployees = employees ? employees.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  useEffect(() => {
    setPage(1);
  }, [totalEmployees]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });

  const handleDelete = (id: number) => {
    deleteMutation.mutate({ id }, {
      onSuccess: () => { toast({ title: "Employee deleted" }); refresh(); },
      onError: () => toast({ title: "Delete failed", variant: "destructive" }),
    });
  };

  const handleToggleStatus = (id: number, current: string) => {
    const newStatus = current === "active" ? "inactive" : "active";
    statusMutation.mutate({ id, data: { status: newStatus } }, {
      onSuccess: () => { toast({ title: `Employee marked ${newStatus}` }); refresh(); },
      onError: () => toast({ title: "Update failed", variant: "destructive" }),
    });
  };

  return (
    <HrLayout>
      <div className="min-h-[calc(100vh-140px)] flex flex-col justify-between gap-6">
        <div className="space-y-5 flex-1">
          <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black">Employees</h2>
            <p className="text-muted-foreground text-sm mt-0.5">{employees?.length ?? 0} records</p>
            {/* Staff / Production toggle */}
            <div className="mt-2">
              <PillTabs
                items={[
                  { value: "staff", label: "Staff", count: staffCount },
                  { value: "production", label: "Production", count: productionCount },
                ]}
                value={typeFilter}
                onChange={(v) => setTypeFilter(v as "staff" | "production")}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate("/hr/employees/bulk-upload")} data-testid="button-bulk-upload">
              <UploadCloud size={16} className="mr-2" /> Bulk Upload
            </Button>
            <Button onClick={() => navigate("/hr/employees/new")} data-testid="button-add-employee">
              <Plus size={16} className="mr-2" /> Add Employee
            </Button>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search by name, email, phone..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-search"
              />
            </div>
            <Select value={deptFilter} onValueChange={setDeptFilter}>
              <SelectTrigger className="w-full sm:w-44" data-testid="select-department">
                <SelectValue placeholder="Department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Departments</SelectItem>
                {departments?.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isBranchScoped && (
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger className="w-full sm:w-44" data-testid="select-branch">
                  <SelectValue placeholder="Branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Branches</SelectItem>
                  {branches?.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-36" data-testid="select-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Code</TableHead>
                  <TableHead>Unit Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Department</TableHead>
                  <TableHead className="hidden md:table-cell">Branch</TableHead>
                  <TableHead className="hidden lg:table-cell">Phone</TableHead>
                  <TableHead className="hidden lg:table-cell">Salary</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-16">
                      <Loader />
                    </TableCell>
                  </TableRow>
                ) : employees && employees.length > 0 ? (
                  paginatedEmployees.map((emp) => (
                    <TableRow key={emp.id} data-testid={`row-employee-${emp.id}`}>
                      <TableCell className="pl-4">
                        <Badge variant="outline" className="font-mono text-xs">{emp.employeeCode}</Badge>
                      </TableCell>
                      <TableCell>
                        {emp.unitCode ? (
                          <span
                            className="text-xs font-mono font-bold text-teal-700 bg-teal-50 border border-teal-200 px-2 py-1 rounded"
                            title={emp.branchName ?? undefined}
                          >
                            {emp.unitCode}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <EmployeeAvatar photoUrl={emp.photoUrl} name={`${emp.firstName} ${emp.lastName}`} size={32} />
                          <div>
                            <p className="font-semibold text-sm">{emp.firstName} {emp.lastName}</p>
                            <p className="text-xs text-muted-foreground">{emp.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{emp.departmentName ?? "—"}</TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        {emp.branchName ? (
                          <span className="inline-flex items-center gap-1.5">
                            {emp.branchName}
                            {emp.branchCode && (
                              <span className="text-[10px] font-mono font-semibold text-teal-700 bg-teal-50 px-1.5 py-0.5 rounded">
                                {emp.branchCode}
                              </span>
                            )}
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">{emp.phone}</TableCell>
                      <TableCell className="hidden lg:table-cell text-sm">
                        ₹{Number(emp.salaryAmount ?? 0).toLocaleString("en-IN")}
                        <span className="text-muted-foreground text-xs ml-1">/{emp.salaryType === "monthly" ? "mo" : "wk"}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={emp.status === "active" ? "default" : "secondary"} className={emp.status === "active" ? "bg-green-100 text-green-800" : ""}>
                          {emp.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <div className="flex items-center gap-1 justify-end">
                          <ActionTooltip label="View profile" color="blue">
                            <Button
                              size="icon" variant="ghost"
                              aria-label="View employee profile"
                              onClick={() => navigate(`/hr/employees/${emp.id}`)}
                              data-testid={`button-view-${emp.id}`}
                            >
                              <Eye size={14} />
                            </Button>
                          </ActionTooltip>

                          <ActionTooltip
                            label={emp.status === "active" ? "Deactivate employee" : "Activate employee"}
                            color={emp.status === "active" ? "amber" : "emerald"}
                          >
                            <Button
                              size="icon" variant="ghost"
                              aria-label={emp.status === "active" ? "Deactivate employee" : "Activate employee"}
                              onClick={() => handleToggleStatus(emp.id, emp.status ?? "active")}
                              data-testid={`button-toggle-${emp.id}`}
                            >
                              {emp.status === "active" ? <UserX size={14} /> : <UserCheck size={14} />}
                            </Button>
                          </ActionTooltip>

                          <ActionTooltip label="Edit details" color="blue">
                            <Button
                              size="icon" variant="ghost"
                              aria-label="Edit employee details"
                              onClick={() => navigate(`/hr/employees/${emp.id}/edit`)}
                              data-testid={`button-edit-${emp.id}`}
                            >
                              <Pencil size={14} />
                            </Button>
                          </ActionTooltip>

                          <AlertDialog>
                            <ActionTooltip label="Delete employee" color="red">
                              <AlertDialogTrigger asChild>
                                <Button
                                  size="icon" variant="ghost" className="text-destructive"
                                  aria-label="Delete employee"
                                  data-testid={`button-delete-${emp.id}`}
                                >
                                  <Trash2 size={14} />
                                </Button>
                              </AlertDialogTrigger>
                            </ActionTooltip>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete employee?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete {emp.firstName} {emp.lastName} and all associated records.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDelete(emp.id)} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">No employees found</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {employees && employees.length > PAGE_SIZE && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t bg-card rounded-lg shadow-sm shrink-0">
          <p className="text-sm text-muted-foreground">
            Showing {paginatedEmployees.length} of {employees.length} records
          </p>
          <Pagination className="mt-2 sm:mt-0">
            <PaginationPrevious
              href="#"
              className={page === 1 ? "pointer-events-none opacity-50" : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (page > 1) {
                  setPage(page - 1);
                }
              }}
            />
            <PaginationContent>
              {Array.from({ length: totalPages }, (_, index) => {
                const pageNumber = index + 1;
                return (
                  <PaginationItem key={pageNumber}>
                    <PaginationLink
                      href="#"
                      isActive={pageNumber === page}
                      onClick={(event) => {
                        event.preventDefault();
                        setPage(pageNumber);
                      }}
                    >
                      {pageNumber}
                    </PaginationLink>
                  </PaginationItem>
                );
              })}
            </PaginationContent>
            <PaginationNext
              href="#"
              className={page === totalPages ? "pointer-events-none opacity-50" : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (page < totalPages) {
                  setPage(page + 1);
                }
              }}
            />
          </Pagination>
        </div>
      )}
    </div>
    </HrLayout>
  );
}
