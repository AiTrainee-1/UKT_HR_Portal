import { useEffect } from "react";
import { useParams, useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetEmployee, useUpdateEmployee, getListEmployeesQueryKey, getGetEmployeeQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import Loader from "@/components/Loader";

const schema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email required"),
  phone: z.string().min(10, "Phone number required"),
  department: z.string().min(1, "Department is required"),
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
});

type FormData = z.infer<typeof schema>;

export default function EditEmployee() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const empId = Number(id);

  const { data: employee, isLoading } = useGetEmployee(empId, {
    query: { enabled: !!empId, queryKey: getGetEmployeeQueryKey(empId) } as any
  });
  const mutation = useUpdateEmployee();

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { salaryType: "monthly", salaryAmount: "" },
  });

  useEffect(() => {
    if (employee) {
      form.reset({
        firstName: employee.firstName ?? "",
        lastName: employee.lastName ?? "",
        email: employee.email ?? "",
        phone: employee.phone ?? "",
        department: employee.departmentName ?? "",
        salaryType: (employee.salaryType as "monthly" | "weekly") ?? "monthly",
        salaryAmount: employee.salaryAmount ? String(employee.salaryAmount) : "",
        joinDate: employee.joinDate ?? "",
        bankName: employee.bankName ?? "",
        bankAccount: employee.bankAccount ?? "",
        bankIfsc: employee.bankIfsc ?? "",
        pfNumber: employee.pfNumber ?? "",
        esiNumber: employee.esiNumber ?? "",
        address: employee.address ?? "",
        idProof: employee.idProof ?? "",
      });
    }
  }, [employee, form]);

  const onSubmit = (data: FormData) => {
    mutation.mutate(
      {
        id: empId,
        data: {
          ...data,
          salaryAmount: Number(data.salaryAmount),
        }
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
      }
    );
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

  return (
    <HrLayout>
      <div className="max-w-3xl space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")} data-testid="button-back">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-black">Edit Employee Details</h2>
            <p className="text-muted-foreground text-sm">Update the fields for {employee.firstName} {employee.lastName}</p>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Basic Information</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="firstName" render={({ field }) => (
                  <FormItem><FormLabel>First Name *</FormLabel><FormControl><Input data-testid="input-first-name" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="lastName" render={({ field }) => (
                  <FormItem><FormLabel>Last Name *</FormLabel><FormControl><Input data-testid="input-last-name" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email *</FormLabel><FormControl><Input type="email" data-testid="input-email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone *</FormLabel><FormControl><Input data-testid="input-phone" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="department" render={({ field }) => (
                  <FormItem><FormLabel>Department *</FormLabel><FormControl><Input data-testid="input-department" placeholder="e.g., Production, Quality, Admin" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="joinDate" render={({ field }) => (
                  <FormItem><FormLabel>Join Date</FormLabel><FormControl><Input type="date" data-testid="input-join-date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Salary</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="salaryType" render={({ field }) => (
                  <FormItem><FormLabel>Salary Type *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-testid="select-salary-type"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="salaryAmount" render={({ field }) => (
                  <FormItem><FormLabel>Amount (₹) *</FormLabel><FormControl><Input type="number" data-testid="input-salary-amount" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Bank & Compliance (Optional)</CardTitle></CardHeader>
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Address</CardTitle></CardHeader>
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
