import { useState } from "react";
import EmployeeLayout from "@/components/EmployeeLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useListLeaveRequests, useCreateLeaveRequest, getListLeaveRequestsQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Calendar } from "lucide-react";
import Loader from "@/components/Loader";

const schema = z.object({
  type: z.enum(["sick", "casual", "annual", "other"]),
  startDate: z.string().min(1, "Start date required"),
  endDate: z.string().min(1, "End date required"),
  reason: z.string().min(5, "Please provide a reason"),
});
type FormData = z.infer<typeof schema>;

function statusBadge(status: string) {
  if (status === "approved") return <Badge className="bg-green-100 text-green-800">Approved</Badge>;
  if (status === "rejected") return <Badge className="bg-red-100 text-red-800">Rejected</Badge>;
  return <Badge className="bg-amber-100 text-amber-800">Pending</Badge>;
}

export default function EmployeeLeave() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: leaves, isLoading } = useListLeaveRequests(
    user?.employeeId ? { employeeId: user.employeeId } : undefined
  );
  const mutation = useCreateLeaveRequest();

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: "casual" },
  });

  const onSubmit = (data: FormData) => {
    if (!user?.employeeId) return;
    mutation.mutate(
      { data: { ...data, employeeId: user.employeeId } },
      {
        onSuccess: () => {
          toast({ title: "Leave request submitted" });
          queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
          setOpen(false);
          form.reset({ type: "casual" });
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? "Failed to submit leave request.";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <EmployeeLayout>
        <div className="flex items-center justify-center min-h-[calc(100vh-140px)]">
          <Loader />
        </div>
      </EmployeeLayout>
    );
  }

  return (
    <EmployeeLayout>
      <div className="max-w-2xl space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black">My Leave</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Apply and track your leave requests</p>
          </div>
          <Button onClick={() => setOpen(true)} data-testid="button-apply-leave">
            <Plus size={16} className="mr-2" /> Apply for Leave
          </Button>
        </div>

        {leaves && leaves.length > 0 ? (
          <div className="space-y-3">
            {leaves.map((leave) => (
              <Card key={leave.id} data-testid={`leave-${leave.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                        <Calendar size={16} className="text-muted-foreground" />
                      </div>
                      <div>
                        <p className="font-semibold text-sm capitalize">{leave.type} Leave</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {leave.startDate} — {leave.endDate}
                        </p>
                        <p className="text-xs text-foreground/70 mt-1 max-w-xs">{leave.reason}</p>
                        {leave.hrComment && (
                          <p className="text-xs text-muted-foreground mt-1 italic">HR: "{leave.hrComment}"</p>
                        )}
                      </div>
                    </div>
                    {statusBadge(leave.status ?? "pending")}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Calendar size={32} className="mb-3 opacity-30" />
              <p className="font-medium">No leave requests yet</p>
              <Button className="mt-4" onClick={() => setOpen(true)} variant="outline">Apply for Leave</Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Apply for Leave</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="type" render={({ field }) => (
                <FormItem><FormLabel>Leave Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-type"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="sick">Sick</SelectItem>
                      <SelectItem value="casual">Casual</SelectItem>
                      <SelectItem value="annual">Annual</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="startDate" render={({ field }) => (
                  <FormItem><FormLabel>From</FormLabel><FormControl><Input type="date" data-testid="input-start-date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="endDate" render={({ field }) => (
                  <FormItem><FormLabel>To</FormLabel><FormControl><Input type="date" data-testid="input-end-date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="reason" render={({ field }) => (
                <FormItem><FormLabel>Reason</FormLabel><FormControl><Textarea rows={3} placeholder="Describe the reason for your leave..." data-testid="input-reason" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel">Cancel</Button>
                <Button type="submit" disabled={mutation.isPending} data-testid="button-submit">
                  {mutation.isPending ? "Submitting..." : "Submit Request"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </EmployeeLayout>
  );
}
