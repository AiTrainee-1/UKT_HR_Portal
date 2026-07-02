import { useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  useCreateEmployee, getListEmployeesQueryKey,
  useListDepartments, useListDesignations,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";

const schema = z.object({
  employeeCode: z.string().min(1, "Employee code is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email required").or(z.literal("")).optional(),
  phone: z.string().min(10, "Phone number required"),
  gender: z.enum(["male", "female", "other"]).optional(),
  dateOfBirth: z.string().optional(),
  employmentType: z.enum(["staff", "production"]),
  departmentId: z.string().optional(),
  designationId: z.string().optional(),
  salaryType: z.enum(["monthly", "weekly"]),
  salaryAmount: z.string().min(1, "Salary amount is required"),
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
});

type FormData = z.infer<typeof schema>;

export default function NewEmployee() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useCreateEmployee();

  const { data: departments } = useListDepartments();
  const [selectedDeptId, setSelectedDeptId] = useState<string>("");
  const { data: designations } = useListDesignations(
    selectedDeptId ? { departmentId: Number(selectedDeptId) } : undefined,
  );

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      salaryType: "monthly",
      employmentType: "staff",
      salaryAmount: "",
    },
  });

  const onSubmit = (data: FormData) => {
    mutation.mutate(
      {
        data: {
          employeeCode: data.employeeCode,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email || undefined,
          phone: data.phone,
          gender: data.gender,
          dateOfBirth: data.dateOfBirth || undefined,
          employmentType: data.employmentType,
          departmentId: data.departmentId ? Number(data.departmentId) : undefined,
          designationId: data.designationId ? Number(data.designationId) : undefined,
          salaryType: data.salaryType,
          salaryAmount: Number(data.salaryAmount),
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
        } as any,
      },
      {
        onSuccess: () => {
          toast({ title: "Employee added successfully" });
          queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
          navigate("/hr/employees");
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? "Failed to add employee.";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-black">Add New Employee</h2>
            <p className="text-muted-foreground text-sm">Fill in the required fields to create the record</p>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

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
                  <FormItem><FormLabel>First Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="lastName" render={({ field }) => (
                  <FormItem><FormLabel>Last Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="gender" render={({ field }) => (
                  <FormItem><FormLabel>Gender</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ""}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select gender" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="male">Male</SelectItem>
                        <SelectItem value="female">Female</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  <FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="dateOfBirth" render={({ field }) => (
                  <FormItem><FormLabel>Date of Birth</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="joinDate" render={({ field }) => (
                  <FormItem><FormLabel>Join Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="employmentType" render={({ field }) => (
                  <FormItem><FormLabel>Employment Type *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="staff">Staff (Monthly)</SelectItem>
                        <SelectItem value="production">Production (Weekly)</SelectItem>
                      </SelectContent>
                    </Select>
                  <FormMessage /></FormItem>
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
              </CardContent>
            </Card>

            {/* Salary */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Salary</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="salaryType" render={({ field }) => (
                  <FormItem><FormLabel>Salary Type *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                      </SelectContent>
                    </Select>
                  <FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="salaryAmount" render={({ field }) => (
                  <FormItem><FormLabel>Amount (₹) *</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
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
                  <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankAccount" render={({ field }) => (
                  <FormItem><FormLabel>Account Number</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankIfsc" render={({ field }) => (
                  <FormItem><FormLabel>IFSC Code</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="pfNumber" render={({ field }) => (
                  <FormItem><FormLabel>PF Number</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="esiNumber" render={({ field }) => (
                  <FormItem><FormLabel>ESI Number</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="idProof" render={({ field }) => (
                  <FormItem><FormLabel>ID Proof</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
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
                  <FormItem><FormLabel>Full Address</FormLabel><FormControl><Textarea rows={3} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </CardContent>
            </Card>

            <Separator />
            <div className="flex gap-3 justify-end pb-4">
              <Button type="button" variant="outline" onClick={() => navigate("/hr/employees")}>Cancel</Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Saving..." : "Save Employee"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </HrLayout>
  );
}
