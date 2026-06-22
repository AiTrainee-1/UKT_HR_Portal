import { useRoute } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useGetJobById, useSubmitApplication } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { Briefcase, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import Loader from "@/components/Loader";

const applySchema = z.object({
  name: z.string().min(1, "Full name is required"),
  email: z.string().email("Valid email required"),
  phone: z.string().min(6, "Phone number is required"),
  coverLetter: z.string().optional(),
  experience: z.string().optional(),
});

type ApplyForm = z.infer<typeof applySchema>;

export default function JobApply() {
  const [, params] = useRoute("/apply/job/:id");
  const jobId = Number(params?.id);
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);

  const { data: job, isLoading, error } = useGetJobById(jobId, { enabled: jobId > 0 });
  const submitMutation = useSubmitApplication();

  const form = useForm<ApplyForm>({
    resolver: zodResolver(applySchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      coverLetter: "",
      experience: "",
    },
  });

  const onSubmit = (data: ApplyForm) => {
    submitMutation.mutate(
      {
        data: {
          jobId,
          name: data.name,
          email: data.email,
          phone: data.phone,
          coverLetter: data.coverLetter || undefined,
          experience: data.experience || undefined,
        },
      },
      {
        onSuccess: () => {
          setSubmitted(true);
          toast({ title: "Application submitted", description: "HR will review your application." });
        },
        onError: () => {
          toast({
            title: "Submission failed",
            description: "Could not submit application. The job may be closed.",
            variant: "destructive",
          });
        },
      },
    );
  };

  if (!jobId || Number.isNaN(jobId)) {
    return (
      <div className="min-h-screen bg-sidebar flex items-center justify-center p-6">
        <p className="text-white/70">Invalid job link.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sidebar">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <div className="mb-8 text-center">
          <p className="text-accent text-xs font-bold tracking-[0.25em] uppercase mb-2">UK Textile</p>
          <h1 className="text-3xl font-black text-white">Job Application</h1>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader />
          </div>
        ) : error || !job ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              This job posting could not be found.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Briefcase size={20} className="text-accent" />
                      {job.title}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      {job.departmentName}
                      {job.salaryRange ? ` · ${job.salaryRange}` : ""}
                    </CardDescription>
                  </div>
                  <Badge variant={job.status === "open" ? "default" : "secondary"}>
                    {job.status}
                  </Badge>
                </div>
              </CardHeader>
              {(job.description || job.requirements) && (
                <CardContent className="space-y-3 text-sm text-muted-foreground border-t pt-4">
                  {job.description && (
                    <div>
                      <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-1">
                        Description
                      </p>
                      <p className="whitespace-pre-wrap">{job.description}</p>
                    </div>
                  )}
                  {job.requirements && (
                    <div>
                      <p className="font-semibold text-foreground text-xs uppercase tracking-wide mb-1">
                        Requirements
                      </p>
                      <p className="whitespace-pre-wrap">{job.requirements}</p>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>

            {submitted ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <CheckCircle2 className="mx-auto text-green-600 mb-3" size={40} />
                  <p className="font-semibold text-lg">Application received</p>
                  <p className="text-muted-foreground text-sm mt-2">
                    Thank you. Our HR team will contact you if shortlisted.
                  </p>
                </CardContent>
              </Card>
            ) : job.status !== "open" ? (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground">
                  This position is closed and no longer accepting applications.
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Apply for this role</CardTitle>
                  <CardDescription>All fields marked * are required.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Full name *</FormLabel>
                            <FormControl>
                              <Input data-testid="input-applicant-name" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="grid sm:grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="email"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Email *</FormLabel>
                              <FormControl>
                                <Input type="email" data-testid="input-applicant-email" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="phone"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Phone *</FormLabel>
                              <FormControl>
                                <Input data-testid="input-applicant-phone" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <FormField
                        control={form.control}
                        name="experience"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Experience</FormLabel>
                            <FormControl>
                              <Textarea
                                rows={3}
                                placeholder="Years of experience, skills, previous roles..."
                                data-testid="input-applicant-experience"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="coverLetter"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Cover letter</FormLabel>
                            <FormControl>
                              <Textarea
                                rows={4}
                                placeholder="Why do you want to join UK Textile?"
                                data-testid="input-applicant-cover-letter"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="submit"
                        className="w-full"
                        disabled={submitMutation.isPending}
                        data-testid="button-submit-application"
                      >
                        {submitMutation.isPending ? "Submitting..." : "Submit application"}
                      </Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
