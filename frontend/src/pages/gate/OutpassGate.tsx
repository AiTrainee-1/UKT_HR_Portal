import { useState } from "react";
import { useRoute } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useOutpassGateInfo, useOutpassGateSubmit } from "@/lib/api-client/custom-hooks";
import { useToast } from "@/hooks/use-toast";
import { DoorOpen, CheckCircle2 } from "lucide-react";
import { CircleLoader } from "@/components/ui/CircleLoader";

const outpassSchema = z.object({
  name: z.string().min(1, "Your name is required"),
  employeeCode: z.string().min(1, "Employee code is required"),
  destination: z.string().min(1, "Please enter where you are going"),
});

type OutpassForm = z.infer<typeof outpassSchema>;

export default function OutpassGate() {
  const [, params] = useRoute("/gate/outpass/:token");
  const token = params?.token ?? "";
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const { data: gate, isLoading, error } = useOutpassGateInfo(token);
  const submitMutation = useOutpassGateSubmit(token);

  const form = useForm<OutpassForm>({
    resolver: zodResolver(outpassSchema),
    defaultValues: { name: "", employeeCode: "", destination: "" },
  });

  const onSubmit = (data: OutpassForm) => {
    submitMutation.mutate(data, {
      onSuccess: () => setSubmitted(true),
      onError: () => {
        toast({ title: "Could not submit", description: "Please try again.", variant: "destructive" });
      },
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-md mx-auto px-4 py-10">
        <div className="mb-8 text-center">
          <DoorOpen className="mx-auto text-accent mb-2" size={28} />
          <p className="text-accent text-xs font-bold tracking-[0.25em] uppercase mb-2">UK Textile</p>
          <h1 className="text-3xl font-black text-foreground">Outpass</h1>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <CircleLoader texts={["UK Textiles", "Outpass", "Loading"]} />
          </div>
        ) : error || !gate ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              This QR code could not be recognized. Please check with HR.
            </CardContent>
          </Card>
        ) : submitted ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckCircle2 className="mx-auto text-green-600 mb-3" size={40} />
              <p className="font-semibold text-lg">Outpass recorded</p>
              <p className="text-muted-foreground text-sm mt-2">You may proceed. Have a safe trip.</p>
              <Button
                variant="outline" className="mt-6"
                onClick={() => { form.reset(); setSubmitted(false); }}
              >
                Submit Another Form
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{gate.branchName}</CardTitle>
              <CardDescription>Fill this in before you leave the gate.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Your name *</FormLabel>
                        <FormControl>
                          <Input autoFocus data-testid="input-outpass-name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="employeeCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Employee code *</FormLabel>
                        <FormControl>
                          <Input data-testid="input-outpass-code" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="destination"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Where are you going? *</FormLabel>
                        <FormControl>
                          <Textarea rows={3} data-testid="input-outpass-destination" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    size="lg"
                    disabled={submitMutation.isPending}
                    data-testid="button-submit-outpass"
                  >
                    {submitMutation.isPending ? "Submitting..." : "Submit"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
