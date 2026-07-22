import { useState } from "react";
import { useParams, useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import PhotoUpload from "@/components/PhotoUpload";
import {
  useGetEmployee, useUpdateEmployee,
  getListEmployeesQueryKey, getGetEmployeeQueryKey,
  useListDepartments, useListDesignations, type Employee,
} from "@/lib/api-client";
import { useListBranches, getListBranchesQueryKey } from "@/lib/api-client/custom-hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import Loader from "@/components/Loader";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const schema = z.object({
  employeeCode: z.string().min(1, "Employee code is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email required").or(z.literal("")).optional(),
  phone: z.string().min(10, "Phone number required"),
  gender: z.string().optional(),
  dateOfBirth: z.string().optional(),
  employmentType: z.string().optional(),
  departmentId: z.string().optional(),
  designationId: z.string().optional(),
  branchId: z.string().optional(),
  salaryType: z.string().optional(),
  salaryAmount: z.string().optional(),
  salaryPerShift: z.string().optional(),
  joinDate: z.string().optional(),
  bankName: z.string().optional(),
  bankAccount: z.string().optional(),
  bankIfsc: z.string().optional(),
  pfNumber: z.string().optional(),
  esiNumber: z.string().optional(),
  address: z.string().optional(),
  idProof: z.string().optional(),
  fatherName: z.string().optional(),
  motherName: z.string().optional(),
  biometricDeviceId: z.string().optional(),
  bloodGroup: z.string().optional(),
  emergencyContact: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

// Pure mapping from the stored record to form field strings — called exactly
// once, by the parent, only after the employee has actually loaded (see
// EditEmployeeForm below). There is no async gap for this to race against.
function employeeToFormData(employee: Employee): FormData {
  const e = employee as Employee & {
    fatherName?: string | null; motherName?: string | null;
    biometricDeviceId?: string | null; salaryPerShift?: number | null;
  };
  return {
    employeeCode: e.employeeCode ?? "",
    firstName: e.firstName ?? "",
    lastName: e.lastName ?? "",
    email: e.email ?? "",
    phone: e.phone ?? "",
    gender: e.gender ?? "",
    dateOfBirth: e.dateOfBirth ?? "",
    employmentType: e.employmentType ?? "staff",
    departmentId: e.departmentId ? String(e.departmentId) : "",
    designationId: e.designationId ? String(e.designationId) : "",
    branchId: e.branchId ? String(e.branchId) : "",
    salaryType: e.salaryType ?? "monthly",
    salaryAmount: e.salaryAmount ? String(e.salaryAmount) : "",
    salaryPerShift: e.salaryPerShift ? String(e.salaryPerShift) : "",
    joinDate: e.joinDate ?? "",
    bankName: e.bankName ?? "",
    bankAccount: e.bankAccount ?? "",
    bankIfsc: e.bankIfsc ?? "",
    pfNumber: e.pfNumber ?? "",
    esiNumber: e.esiNumber ?? "",
    address: e.address ?? "",
    idProof: e.idProof ?? "",
    fatherName: e.fatherName ?? "",
    motherName: e.motherName ?? "",
    biometricDeviceId: e.biometricDeviceId ?? "",
    bloodGroup: e.bloodGroup ?? "",
    emergencyContact: e.emergencyContact ?? "",
  };
}

export default function EditEmployee() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const empId = Number(id);

  const { data: employee, isLoading } = useGetEmployee(empId, {
    query: { enabled: !!empId, queryKey: getGetEmployeeQueryKey(empId) } as any,
  });

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

  // `employee` is guaranteed non-null from here on, so mounting this child
  // now (never before) means every hook inside it — including useForm — runs
  // for the very first time with the real, already-loaded record. There is
  // no "form exists before its data does" window for any value to be lost in.
  return <EditEmployeeForm key={employee.id} empId={empId} employee={employee} />;
}

function EditEmployeeForm({ empId, employee }: { empId: number; employee: Employee }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useUpdateEmployee();
  const { user } = useAuth();

  const [photoUrl, setPhotoUrl] = useState<string | null>(employee.photoUrl ?? null);
  const [selectedDeptId, setSelectedDeptId] = useState<string>(
    employee.departmentId ? String(employee.departmentId) : "",
  );

  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !user?.branchId, queryKey: getListBranchesQueryKey() });
  const { data: designations } = useListDesignations(
    selectedDeptId ? { departmentId: Number(selectedDeptId) } : undefined,
  );

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: employeeToFormData(employee),
  });

  const employmentType = form.watch("employmentType");

  const onSubmit = (data: FormData) => {
    mutation.mutate(
      {
        id: empId,
        data: {
          employeeCode: data.employeeCode,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email || undefined,
          phone: data.phone,
          gender: data.gender,
          dateOfBirth: data.dateOfBirth || undefined,
          employmentType: data.employmentType,
          departmentId: data.departmentId ? Number(data.departmentId) : null,
          designationId: data.designationId ? Number(data.designationId) : null,
          branchId: data.branchId ? Number(data.branchId) : null,
          salaryType: data.salaryType,
          salaryAmount: data.employmentType === "production" ? undefined : (data.salaryAmount ? Number(data.salaryAmount) : undefined),
          salaryPerShift: data.employmentType === "production" ? (data.salaryPerShift ? Number(data.salaryPerShift) : undefined) : undefined,
          joinDate: data.joinDate || undefined,
          bankName: data.bankName || undefined,
          bankAccount: data.bankAccount || undefined,
          bankIfsc: data.bankIfsc || undefined,
          pfNumber: data.pfNumber || undefined,
          esiNumber: data.esiNumber || undefined,
          address: data.address || undefined,
          idProof: data.idProof || undefined,
          fatherName: data.fatherName || undefined,
          motherName: data.motherName || undefined,
          biometricDeviceId: data.biometricDeviceId || undefined,
          photoUrl: photoUrl || undefined,
          bloodGroup: data.bloodGroup || undefined,
          emergencyContact: data.emergencyContact || undefined,
        } as any,
      },
      {
        onSuccess: () => {
          toast({ title: "Employee updated successfully" });
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(empId) });
          navigate("/hr/employees");
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? "Failed to update employee.";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")} data-testid="button-back">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-black">Edit Employee Details</h2>
            <p className="text-muted-foreground text-sm">
              Updating record for {employee.firstName} {employee.lastName}
            </p>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

            {/* Profile Photo */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Profile Photo</CardTitle>
              </CardHeader>
              <CardContent>
                <PhotoUpload value={photoUrl} onChange={setPhotoUrl} />
              </CardContent>
            </Card>

            {/* Basic Information */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="employeeCode" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Employee Code *</FormLabel><FormControl><Input placeholder="e.g. 1570 or EMP001" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="firstName" render={({ field }) => (
                  <FormItem><FormLabel>First Name *</FormLabel><FormControl><Input data-testid="input-first-name" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="lastName" render={({ field }) => (
                  <FormItem><FormLabel>Last Name *</FormLabel><FormControl><Input data-testid="input-last-name" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" data-testid="input-email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone *</FormLabel><FormControl><Input data-testid="input-phone" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                {/* Plain native <select> — Department/Designation/Branch below have always
                    used this and have never had a display bug; the Radix-based dropdown
                    component this page used to use here could not. */}
                <FormField control={form.control} name="gender" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Gender</FormLabel>
                    <FormControl>
                      <select
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        data-testid="select-gender"
                      >
                        <option value="">Select gender</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="dateOfBirth" render={({ field }) => (
                  <FormItem><FormLabel>Date of Birth</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="joinDate" render={({ field }) => (
                  <FormItem><FormLabel>Join Date</FormLabel><FormControl><Input type="date" data-testid="input-join-date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="employmentType" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employment Type</FormLabel>
                    <FormControl>
                      <select
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        data-testid="select-employment-type"
                      >
                        <option value="staff">Staff (Monthly)</option>
                        <option value="production">Production (Weekly)</option>
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </CardContent>
            </Card>

            {/* Department & Designation */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Department & Designation</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="departmentId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department</FormLabel>
                    <FormControl>
                      <select
                        value={field.value ?? ""}
                        onChange={(e) => {
                          field.onChange(e.target.value);
                          setSelectedDeptId(e.target.value);
                          form.setValue("designationId", "");
                        }}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        data-testid="input-department"
                      >
                        <option value="">— Select Department —</option>
                        {(departments ?? []).map((d) => (
                          <option key={d.id} value={String(d.id)}>{d.name}</option>
                        ))}
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="designationId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Designation</FormLabel>
                    <FormControl>
                      <select
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                      >
                        <option value="">— Select Designation —</option>
                        {(designations ?? []).map((d) => (
                          <option key={d.id} value={String(d.id)}>{d.title}</option>
                        ))}
                      </select>
                    </FormControl>
                    {selectedDeptId && (designations ?? []).length === 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        No designations in this department yet.
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )} />
                {!user?.branchId && (
                  <FormField control={form.control} name="branchId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Branch</FormLabel>
                      <FormControl>
                        <select
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        >
                          <option value="">— Select Branch —</option>
                          {(branches ?? []).map((b) => (
                            <option key={b.id} value={String(b.id)}>{b.name}{b.isHeadOffice ? " (Head Office)" : ""}</option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}
              </CardContent>
            </Card>

            {/* Salary */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Salary</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {employmentType === "production" ? (
                  <FormField control={form.control} name="salaryPerShift" render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Salary Per Shift (₹) *</FormLabel>
                      <FormControl><Input type="number" step="0.01" placeholder="e.g. 300" {...field} /></FormControl>
                      <p className="text-xs text-muted-foreground mt-1">
                        Production pay = Total Shifts Worked × Salary Per Shift. No monthly amount needed.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )} />
                ) : (
                  <>
                    <FormField control={form.control} name="salaryType" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Salary Type *</FormLabel>
                        <FormControl>
                          <select
                            value={field.value ?? "monthly"}
                            onChange={field.onChange}
                            className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                            data-testid="select-salary-type"
                          >
                            <option value="monthly">Monthly</option>
                            <option value="weekly">Weekly</option>
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="salaryAmount" render={({ field }) => (
                      <FormItem><FormLabel>Amount (₹) *</FormLabel><FormControl><Input type="number" data-testid="input-salary-amount" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </>
                )}
              </CardContent>
            </Card>

            {/* Biometric Device */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Biometric Device</CardTitle>
              </CardHeader>
              <CardContent>
                <FormField control={form.control} name="biometricDeviceId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Device Enrollment ID</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 001 or 1570 — the ID used on the eSSL device" {...field} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground mt-1">
                      Enter the exact User ID this employee was enrolled with on the biometric device. Check the device: Main Menu → User Mgt → All Users.
                    </p>
                    <FormMessage />
                  </FormItem>
                )} />
              </CardContent>
            </Card>

            {/* Bank & Compliance */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Bank & Compliance (Optional)</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="bankName" render={({ field }) => (
                  <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input data-testid="input-bank-name" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankAccount" render={({ field }) => (
                  <FormItem><FormLabel>Account Number</FormLabel><FormControl><Input data-testid="input-bank-account" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankIfsc" render={({ field }) => (
                  <FormItem><FormLabel>IFSC Code</FormLabel><FormControl><Input data-testid="input-bank-ifsc" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="pfNumber" render={({ field }) => (
                  <FormItem><FormLabel>PF Number</FormLabel><FormControl><Input data-testid="input-pf-number" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="esiNumber" render={({ field }) => (
                  <FormItem><FormLabel>ESI Number</FormLabel><FormControl><Input data-testid="input-esi-number" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="idProof" render={({ field }) => (
                  <FormItem><FormLabel>ID Proof</FormLabel><FormControl><Input data-testid="input-id-proof" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bloodGroup" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Blood Group</FormLabel>
                    <FormControl>
                      <select
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                        data-testid="select-blood-group"
                      >
                        <option value="">Select blood group</option>
                        {BLOOD_GROUPS.map((bg) => (
                          <option key={bg} value={bg}>{bg}</option>
                        ))}
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="emergencyContact" render={({ field }) => (
                  <FormItem><FormLabel>Emergency Contact</FormLabel><FormControl><Input placeholder="Name and phone number" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </CardContent>
            </Card>

            {/* Family Information */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Family Information</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="fatherName" render={({ field }) => (
                  <FormItem><FormLabel>Father's Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="motherName" render={({ field }) => (
                  <FormItem><FormLabel>Mother's Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </CardContent>
            </Card>

            {/* Address */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Address</CardTitle>
              </CardHeader>
              <CardContent>
                <FormField control={form.control} name="address" render={({ field }) => (
                  <FormItem><FormLabel>Full Address</FormLabel><FormControl><Textarea rows={3} data-testid="input-address" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </CardContent>
            </Card>

            <Separator />
            <div className="flex gap-3 justify-end pb-4">
              <Button type="button" variant="outline" onClick={() => navigate("/hr/employees")} data-testid="button-cancel">Cancel</Button>
              <Button type="submit" data-testid="button-save" disabled={mutation.isPending}>
                {mutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </HrLayout>
  );
}
