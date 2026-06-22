import { useLocation } from "wouter";
import { useSetEmployeePassword } from "@/lib/api-client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Lock } from "lucide-react";

const schema = z.object({
  identifier: z.string().min(1, "Please enter your phone, email, or employee ID"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirm: z.string().min(8, "Please confirm your password"),
}).refine((d) => d.password === d.confirm, {
  message: "Passwords do not match",
  path: ["confirm"],
});

type FormData = z.infer<typeof schema>;

export default function SetPassword() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const mutation = useSetEmployeePassword();

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: "", password: "", confirm: "" },
  });

  const onSubmit = (data: FormData) => {
    mutation.mutate(
      { data: { identifier: data.identifier, password: data.password } },
      {
        onSuccess: () => {
          toast({ title: "Password set", description: "You can now login with your new password." });
          navigate("/employee-login");
        },
        onError: (err: unknown) => {
          const message = (err as { data?: { error?: string } })?.data?.error ?? "Failed to set password.";
          toast({ title: "Error", description: message, variant: "destructive" });
        },
      }
    );
  };

  return (
    <div className="min-h-screen bg-sidebar flex flex-col items-center justify-center px-6">
      <div className="absolute inset-0 opacity-5" style={{
        backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.1) 10px, rgba(255,255,255,0.1) 11px)`,
      }} />

      <div className="relative w-full max-w-md">
        <button onClick={() => navigate("/employee-login")} className="flex items-center gap-2 text-white/40 hover:text-white/70 text-sm mb-8 transition-colors">
          <ArrowLeft size={16} /> Back to Login
        </button>

        <div className="bg-card rounded-2xl p-8 shadow-xl border border-border">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <Lock size={20} className="text-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">Set Your Password</h2>
              <p className="text-muted-foreground text-sm">First-time login setup</p>
            </div>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormField control={form.control} name="identifier" render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone / Email / Employee ID</FormLabel>
                  <FormControl><Input placeholder="Your registered identifier" data-testid="input-identifier" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem>
                  <FormLabel>New Password</FormLabel>
                  <FormControl><Input type="password" placeholder="Minimum 8 characters" data-testid="input-password" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="confirm" render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm Password</FormLabel>
                  <FormControl><Input type="password" placeholder="Repeat your password" data-testid="input-confirm" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <Button type="submit" className="w-full" data-testid="button-submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Setting password..." : "Set Password"}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
