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
import {
  useVisitorGateInfo, useVisitorCheckPhone, useVisitorGateNew, useVisitorGateRepeat,
} from "@/lib/api-client/custom-hooks";
import { useToast } from "@/hooks/use-toast";
import { UserRound, CheckCircle2, UserPlus, History } from "lucide-react";
import { CircleLoader } from "@/components/ui/CircleLoader";

type Step = "choice" | "new" | "repeat-phone" | "repeat-details" | "done";

const newVisitorSchema = z.object({
  name: z.string().min(1, "Your name is required"),
  phone: z.string().min(6, "A valid phone number is required"),
  aadhaarNumber: z.string().optional(),
  whyCame: z.string().optional(),
  whomToMeet: z.string().min(1, "Please enter whom you're meeting"),
  purpose: z.string().min(1, "Please enter the purpose of your visit"),
});
type NewVisitorForm = z.infer<typeof newVisitorSchema>;

const repeatDetailsSchema = z.object({
  whomToMeet: z.string().min(1, "Please enter whom you're meeting"),
  purpose: z.string().min(1, "Please enter the purpose of your visit"),
});
type RepeatDetailsForm = z.infer<typeof repeatDetailsSchema>;

export default function VisitorGate() {
  const [, params] = useRoute("/gate/visitor/:token");
  const token = params?.token ?? "";
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("choice");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [returningName, setReturningName] = useState("");

  const { data: gate, isLoading, error } = useVisitorGateInfo(token);
  const checkPhoneMutation = useVisitorCheckPhone(token);
  const newMutation = useVisitorGateNew(token);
  const repeatMutation = useVisitorGateRepeat(token);

  const newForm = useForm<NewVisitorForm>({
    resolver: zodResolver(newVisitorSchema),
    defaultValues: { name: "", phone: "", aadhaarNumber: "", whyCame: "", whomToMeet: "", purpose: "" },
  });
  const repeatForm = useForm<RepeatDetailsForm>({
    resolver: zodResolver(repeatDetailsSchema),
    defaultValues: { whomToMeet: "", purpose: "" },
  });

  const submitNew = (data: NewVisitorForm) => {
    newMutation.mutate(
      {
        name: data.name, phone: data.phone,
        aadhaarNumber: data.aadhaarNumber || undefined,
        whyCame: data.whyCame || undefined,
        whomToMeet: data.whomToMeet, purpose: data.purpose,
      },
      {
        onSuccess: () => setStep("done"),
        onError: () => {
          toast({
            title: "Could not submit",
            description: "This phone number may already be registered — try \"Already Visited\" instead.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const verifyPhone = () => {
    setPhoneError(null);
    if (!phone.trim()) {
      setPhoneError("Please enter your phone number.");
      return;
    }
    checkPhoneMutation.mutate(
      { phone: phone.trim() },
      {
        onSuccess: (res) => {
          if (res.found) {
            setReturningName(res.name ?? "");
            setStep("repeat-details");
          } else {
            setPhoneError('No record found for this number. Please use "New Visitor" instead.');
          }
        },
        onError: () => setPhoneError("Could not verify right now. Please try again."),
      },
    );
  };

  const resetAll = () => {
    newForm.reset();
    repeatForm.reset();
    setPhone("");
    setPhoneError(null);
    setReturningName("");
    setStep("choice");
  };

  const submitRepeat = (data: RepeatDetailsForm) => {
    repeatMutation.mutate(
      { phone: phone.trim(), whomToMeet: data.whomToMeet, purpose: data.purpose },
      {
        onSuccess: () => setStep("done"),
        onError: () => {
          toast({ title: "Could not submit", description: "Please try again.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-md mx-auto px-4 py-10">
        <div className="mb-8 text-center">
          <UserRound className="mx-auto text-accent mb-2" size={28} />
          <p className="text-accent text-xs font-bold tracking-[0.25em] uppercase mb-2">UK Textile</p>
          <h1 className="text-3xl font-black text-foreground">Visitor Pass</h1>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <CircleLoader texts={["UK Textiles", "Visitor Pass", "Loading"]} />
          </div>
        ) : error || !gate ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              This QR code could not be recognized. Please check with the front desk.
            </CardContent>
          </Card>
        ) : step === "done" ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckCircle2 className="mx-auto text-green-600 mb-3" size={40} />
              <p className="font-semibold text-lg">You're checked in</p>
              <p className="text-muted-foreground text-sm mt-2">Please wait, someone will be with you shortly.</p>
              <Button variant="outline" className="mt-6" onClick={resetAll}>
                Submit Another Form
              </Button>
            </CardContent>
          </Card>
        ) : step === "choice" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{gate.branchName}</CardTitle>
              <CardDescription>Have you visited us before?</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Button size="lg" className="w-full h-14 gap-2 justify-start text-base" onClick={() => setStep("new")}>
                <UserPlus size={18} /> New Visitor
              </Button>
              <Button
                size="lg" variant="outline" className="w-full h-14 gap-2 justify-start text-base"
                onClick={() => setStep("repeat-phone")}
              >
                <History size={18} /> Already Visited
              </Button>
            </CardContent>
          </Card>
        ) : step === "repeat-phone" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Welcome back</CardTitle>
              <CardDescription>Enter your phone number to look up your details.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Input
                  autoFocus placeholder="Phone number" value={phone}
                  onChange={(e) => { setPhone(e.target.value); setPhoneError(null); }}
                  data-testid="input-visitor-phone"
                />
                {phoneError && <p className="text-sm text-destructive">{phoneError}</p>}
              </div>
              <Button
                className="w-full" size="lg" onClick={verifyPhone}
                disabled={checkPhoneMutation.isPending} data-testid="button-verify-phone"
              >
                {checkPhoneMutation.isPending ? "Verifying..." : "Verify"}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => setStep("choice")}>Back</Button>
            </CardContent>
          </Card>
        ) : step === "repeat-details" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Welcome back{returningName ? `, ${returningName}` : ""}!</CardTitle>
              <CardDescription>Just confirm today's visit details.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...repeatForm}>
                <form onSubmit={repeatForm.handleSubmit(submitRepeat)} className="space-y-4">
                  <FormField
                    control={repeatForm.control}
                    name="whomToMeet"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Whom are you meeting? *</FormLabel>
                        <FormControl><Input autoFocus data-testid="input-repeat-whom" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={repeatForm.control}
                    name="purpose"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Purpose of visit *</FormLabel>
                        <FormControl><Textarea rows={3} data-testid="input-repeat-purpose" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full" size="lg" disabled={repeatMutation.isPending} data-testid="button-submit-repeat">
                    {repeatMutation.isPending ? "Submitting..." : "Submit"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{gate.branchName}</CardTitle>
              <CardDescription>Tell us a bit about your visit.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...newForm}>
                <form onSubmit={newForm.handleSubmit(submitNew)} className="space-y-4">
                  <FormField
                    control={newForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Your name *</FormLabel>
                        <FormControl><Input autoFocus data-testid="input-new-name" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={newForm.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone number *</FormLabel>
                        <FormControl><Input data-testid="input-new-phone" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={newForm.control}
                    name="aadhaarNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Aadhaar number</FormLabel>
                        <FormControl><Input data-testid="input-new-aadhaar" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={newForm.control}
                    name="whomToMeet"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Whom are you meeting? *</FormLabel>
                        <FormControl><Input data-testid="input-new-whom" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={newForm.control}
                    name="purpose"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Purpose of visit *</FormLabel>
                        <FormControl><Textarea rows={2} data-testid="input-new-purpose" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={newForm.control}
                    name="whyCame"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Why did you come?</FormLabel>
                        <FormControl><Textarea rows={2} data-testid="input-new-why" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full" size="lg" disabled={newMutation.isPending} data-testid="button-submit-new-visitor">
                    {newMutation.isPending ? "Submitting..." : "Submit"}
                  </Button>
                  <Button type="button" variant="ghost" className="w-full" onClick={() => setStep("choice")}>Back</Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
