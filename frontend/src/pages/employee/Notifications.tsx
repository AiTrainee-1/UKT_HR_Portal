import { useState } from "react";
import EmployeeLayout from "@/components/EmployeeLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useCreateNotification } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Send, MessageSquare, IndianRupee, Calendar, Plus } from "lucide-react";

const schema = z.object({
  type: z.enum(["salary_complaint", "leave_request", "general"]),
  message: z.string().min(10, "Please write at least 10 characters"),
});
type FormData = z.infer<typeof schema>;

const typeOptions = [
  { value: "salary_complaint", label: "Salary Complaint", icon: IndianRupee },
  { value: "leave_request", label: "Leave Request", icon: Calendar },
  { value: "general", label: "General Message", icon: MessageSquare },
];

export default function EmployeeNotifications() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<Array<{ type: string; message: string; sentAt: string }>>([]);
  const { user } = useAuth();
  const { toast } = useToast();
  const mutation = useCreateNotification();

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: "general" },
  });

  const onSubmit = (data: FormData) => {
    if (!user?.employeeId) return;
    mutation.mutate(
      { data: { ...data, employeeId: user.employeeId } },
      {
        onSuccess: () => {
          toast({ title: "Message sent to HR" });
          setSent((prev) => [{ ...data, sentAt: new Date().toLocaleString("en-IN") }, ...prev]);
          setOpen(false);
          form.reset({ type: "general" });
        },
        onError: () => toast({ title: "Failed to send message", variant: "destructive" }),
      }
    );
  };

  return (
    <EmployeeLayout>
      <div className="max-w-2xl space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black">Messages to HR</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Send complaints, requests, or general messages</p>
          </div>
          <Button onClick={() => setOpen(true)} data-testid="button-new-message">
            <Plus size={16} className="mr-2" /> New Message
          </Button>
        </div>

        {/* Message types */}
        <div className="grid grid-cols-3 gap-3">
          {typeOptions.map(({ value, label, icon: Icon }) => (
            <Card key={value}
              className="cursor-pointer hover:border-accent/50 hover:bg-accent/5 transition-colors"
              onClick={() => { form.setValue("type", value as FormData["type"]); setOpen(true); }}
              data-testid={`card-type-${value}`}
            >
              <CardContent className="p-4 text-center">
                <Icon size={20} className="mx-auto mb-2 text-muted-foreground" />
                <p className="text-xs font-medium text-foreground">{label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Sent messages */}
        {sent.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Recently Sent</p>
            {sent.map((msg, i) => {
              const typeOpt = typeOptions.find((t) => t.value === msg.type);
              const Icon = typeOpt?.icon ?? MessageSquare;
              return (
                <Card key={i} className="border-green-200 bg-green-50/50" data-testid={`sent-message-${i}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                        <Icon size={14} className="text-green-600" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-green-700">{typeOpt?.label}</p>
                          <p className="text-xs text-muted-foreground">{msg.sentAt}</p>
                        </div>
                        <p className="text-sm text-foreground mt-1.5">{msg.message}</p>
                        <p className="text-xs text-green-600 mt-1.5 flex items-center gap-1">
                          <Send size={10} /> Delivered to HR
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {sent.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <MessageSquare size={32} className="mb-3 opacity-30" />
              <p className="font-medium">No messages sent yet</p>
              <p className="text-sm mt-1">Your messages to HR will appear here</p>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Send Message to HR</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="type" render={({ field }) => (
                <FormItem><FormLabel>Message Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-type"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      {typeOptions.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                    </SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="message" render={({ field }) => (
                <FormItem><FormLabel>Message</FormLabel>
                  <FormControl>
                    <Textarea rows={4} placeholder="Describe your message, complaint, or request in detail..." data-testid="input-message" {...field} />
                  </FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel">Cancel</Button>
                <Button type="submit" disabled={mutation.isPending} data-testid="button-send">
                  <Send size={14} className="mr-2" />
                  {mutation.isPending ? "Sending..." : "Send to HR"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </EmployeeLayout>
  );
}
