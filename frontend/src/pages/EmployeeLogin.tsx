import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useEmployeeLogin } from "@/lib/api-client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, User } from "lucide-react";

const schema = z.object({
  identifier: z.string().min(1, "Please enter your phone, email, or employee ID"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type FormData = z.infer<typeof schema>;

export default function EmployeeLogin() {
  const [, navigate] = useLocation();
  const { login } = useAuth();
  const { toast } = useToast();
  const mutation = useEmployeeLogin();

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { identifier: "", password: "" },
  });

  const onSubmit = (data: FormData) => {
    mutation.mutate(
      { data },
      {
        onSuccess: (res) => {
          login(res.token, res.role as "employee", res.employeeId ?? null, res.name);
          navigate("/employee/dashboard");
        },
        onError: (err: unknown) => {
          const message = (err as { data?: { error?: string } })?.data?.error ?? "Login failed. Please check your credentials.";
          toast({ title: "Login failed", description: message, variant: "destructive" });
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
        <button onClick={() => navigate("/login")} className="flex items-center gap-2 text-white/40 hover:text-white/70 text-sm mb-8 transition-colors">
          <ArrowLeft size={16} /> Back
        </button>

        <div className="bg-card rounded-2xl p-8 shadow-xl border border-border">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <User size={20} className="text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">Employee Login</h2>
              <p className="text-muted-foreground text-sm">Use your phone, email, or employee ID</p>
            </div>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormField
                control={form.control}
                name="identifier"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone / Email / Employee ID</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 9876543210 or 1/25" data-testid="input-identifier" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Minimum 8 characters" data-testid="input-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" data-testid="button-submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Signing in..." : "Sign In"}
              </Button>
            </form>
          </Form>

          <div className="mt-6 pt-5 border-t border-border text-center">
            <p className="text-sm text-muted-foreground">
              First time logging in?{" "}
              <button
                onClick={() => navigate("/set-password")}
                data-testid="link-set-password"
                className="text-accent font-medium hover:underline"
              >
                Set your password
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
