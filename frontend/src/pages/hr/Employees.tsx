import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { CircleLoader } from "@/components/ui/CircleLoader";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { ActionTooltip } from "@/components/ui/action-tooltip";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  useListDepartments, useDeleteEmployee, useUpdateEmployeeStatus,
  getListEmployeesQueryKey
} from "@/lib/api-client";
import {
  useListBranches, getListBranchesQueryKey,
  useListEmployeesPaginated, useEmployeeCount, useUpdateEmployeeCoEmp,
} from "@/lib/api-client/custom-hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, UserCheck, UserX, Trash2, Eye, Pencil, UploadCloud } from "lucide-react";
import { DataPagination } from "@/components/ui/DataPagination";

export default function Employees() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  // Active by default: the main table is the working roster, and leavers
  // sitting in it inflate every count and every search. Inactive employees
  // are still reachable -see the Inactive toggle in the header.
  const [statusFilter, setStatusFilter] = useState("active");
  const viewingInactive = statusFilter === "inactive";
  const [typeFilter, setTypeFilter] = useState<"staff" | "production" | "coemp">("staff");
  // "Co Emp" is a cross-cutting view (every employee, regardless of staff vs.
  // production), not a real employmentType -so it's excluded from the filter
  // sent to the server rather than treated as a third employmentType value.
  const viewingCoEmp = typeFilter === "coemp";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;

  const [page, setPage] = useState(1);
  // State, not a constant -the pagination bar lets the user change it.
  const [pageSize, setPageSize] = useState(10);

  // Debounced: searching used to filter an already-fully-downloaded array in
  // the browser, instantly, on every keystroke. Now that the server does the
  // filtering (so it can filter before paginating, on data it hasn't sent
  // yet), every change is a network request -debouncing keeps that from
  // firing once per keystroke while still feeling immediate once you pause.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filterParams = {
    departmentId: deptFilter !== "all" ? Number(deptFilter) : undefined,
    branchId: !isBranchScoped && branchFilter !== "all" ? Number(branchFilter) : undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    employmentType: viewingCoEmp ? undefined : typeFilter,
    search: debouncedSearch || undefined,
  };

  const { data: pageData, isLoading, isPlaceholderData } = useListEmployeesPaginated({
    ...filterParams, page, pageSize,
  });
  const paginatedEmployees = pageData?.results ?? [];
  const totalEmployees = pageData?.count ?? 0;
  const staffCount = pageData?.staffCount ?? 0;
  const productionCount = pageData?.productionCount ?? 0;

  // Only a number -never fetches the inactive employees themselves (photos
  // included) purely to show this badge, which is what happened before.
  const { data: inactiveCount = 0 } = useEmployeeCount({
    departmentId: filterParams.departmentId,
    branchId: filterParams.branchId,
    status: "inactive",
  });

  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const deleteMutation = useDeleteEmployee();
  const statusMutation = useUpdateEmployeeStatus();
  const coEmpMutation = useUpdateEmployeeCoEmp();

  const totalPages = Math.max(1, Math.ceil(totalEmployees / pageSize));

  // Any filter changing invalidates which page "1" even means -e.g. a
  // department with only 3 people can't show a page 4 that used to exist
  // under a broader filter. Keyed on the filter VALUES, not on
  // totalEmployees, so this fires exactly once per actual filter change
  // rather than once per page's worth of server response.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterParams.departmentId, filterParams.branchId, filterParams.status,
    filterParams.employmentType, filterParams.search,
  ]);

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

  const handleToggleCoEmp = (employeeId: number, current: boolean) => {
    coEmpMutation.mutate({ employeeId, enabled: !current }, {
      onSuccess: () => { toast({ title: !current ? "Enabled for Co Emp" : "Disabled for Co Emp" }); refresh(); },
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
            <p className="text-muted-foreground text-sm mt-0.5">{totalEmployees} records</p>
            {/* Staff / Production toggle */}
            <div className="mt-2">
              <PillTabs
                items={[
                  { value: "staff", label: "Staff", count: staffCount },
                  { value: "production", label: "Production", count: productionCount },
                  { value: "coemp", label: "Co Emp" },
                ]}
                value={typeFilter}
                onChange={(v) => setTypeFilter(v as "staff" | "production" | "coemp")}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Drives the same `statusFilter` the Select below does, rather
                than adding a second source of truth -so the two controls can
                never disagree about what the table is showing. */}
            <Button
              variant={viewingInactive ? "default" : "outline"}
              onClick={() => setStatusFilter(viewingInactive ? "active" : "inactive")}
              data-testid="button-toggle-inactive"
              title={viewingInactive ? "Back to active employees" : "Show inactive employees only"}
            >
              <UserX size={16} className="mr-2" />
              {viewingInactive ? "Viewing Inactive" : "Inactive"}
              {!viewingInactive && inactiveCount > 0 && (
                <span className="ml-2 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-bold text-gray-700">
                  {inactiveCount}
                </span>
              )}
            </Button>
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
          {viewingInactive && (
            <div className="flex items-center gap-2 border-b bg-amber-50/70 px-4 py-2.5">
              <UserX size={14} className="shrink-0 text-amber-600" />
              <p className="text-xs text-amber-800">
                Showing <b>inactive employees only</b>. These are excluded from the main
                roster, counts and searches.
              </p>
            </div>
          )}
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
                  {viewingCoEmp && <TableHead>Co Emp</TableHead>}
                  <TableHead className="pr-4 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody
                // The previous page's rows stay visible (see placeholderData
                // above) while the next page loads, dimmed slightly so a
                // Next/Previous click reads as "loading", not as if nothing
                // happened yet.
                className={isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}
              >
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={viewingCoEmp ? 10 : 9} className="py-16">
                      <CircleLoader />
                    </TableCell>
                  </TableRow>
                ) : paginatedEmployees.length > 0 ? (
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
                      {viewingCoEmp && (
                        <TableCell>
                          <Switch
                            checked={emp.coEmpEnabled ?? false}
                            onCheckedChange={() => handleToggleCoEmp(emp.id, emp.coEmpEnabled ?? false)}
                            aria-label={`Toggle Co Emp for ${emp.firstName} ${emp.lastName}`}
                            data-testid={`switch-coemp-${emp.id}`}
                          />
                        </TableCell>
                      )}
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
                    <TableCell colSpan={viewingCoEmp ? 10 : 9} className="text-center py-12 text-muted-foreground">No employees found</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <DataPagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalItems={totalEmployees}
        className="px-4 border-t bg-card rounded-lg shadow-sm shrink-0"
      />

    </div>
    </HrLayout>
  );
}
