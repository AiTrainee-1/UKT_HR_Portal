import { useState, useEffect } from "react";
import HrLayout from "@/components/HrLayout";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import {
  useListJobs,
  useListApplicants,
  useCreateJob,
  useDeleteJob,
  useUpdateApplicantStatus,
  useGetInterviewSummary,
  useListDepartments,
  getListJobsQueryKey,
  getListApplicantsQueryKey,
  buildJobApplyUrl,
} from "@/lib/api-client";
import type { Applicant } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Briefcase, Users, CheckSquare, XSquare, Share2, Trash2, Eye } from "lucide-react";
import Loader from "@/components/Loader";

const jobSchema = z.object({
  title: z.string().min(1, "Title required"),
  departmentId: z.string().min(1, "Department required"),
  description: z.string().optional(),
  requirements: z.string().optional(),
  salaryRange: z.string().optional(),
});
type JobForm = z.infer<typeof jobSchema>;

function statusBadge(status: string) {
  const map: Record<string, string> = {
    applied: "bg-blue-100 text-blue-800",
    attended: "bg-purple-100 text-purple-800",
    selected: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
  };
  return <Badge className={map[status] ?? ""}>{status}</Badge>;
}

export default function Interviews() {
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null);
  const [viewApplicant, setViewApplicant] = useState<Applicant | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: jobs, isLoading: jobsLoading } = useListJobs({});
  const { data: departments } = useListDepartments();
  const { data: summary } = useGetInterviewSummary();
  const { data: applicants, isLoading: appLoading } = useListApplicants(
    selectedJobId ? { jobId: selectedJobId } : {},
  );
  const createJobMutation = useCreateJob();
  const deleteJobMutation = useDeleteJob();
  const updateApplicantMutation = useUpdateApplicantStatus();

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 2;
  const totalJobs = jobs?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalJobs / PAGE_SIZE));
  const paginatedJobs = jobs ? jobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  useEffect(() => {
    setPage(1);
  }, [totalJobs]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const form = useForm<JobForm>({
    resolver: zodResolver(jobSchema),
    defaultValues: {},
  });

  const onCreateJob = (data: JobForm) => {
    createJobMutation.mutate(
      { data: { ...data, departmentId: Number(data.departmentId) } },
      {
        onSuccess: () => {
          toast({ title: "Job posted" });
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          setNewJobOpen(false);
          form.reset();
        },
        onError: () => toast({ title: "Failed to create job", variant: "destructive" }),
      },
    );
  };

  const handleShare = async (jobId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = buildJobApplyUrl(jobId);
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Share link copied", description: url });
    } catch {
      toast({ title: "Share link", description: url });
    }
  };

  const confirmDeleteJob = () => {
    if (!deleteJobId) return;
    deleteJobMutation.mutate(
      { id: deleteJobId },
      {
        onSuccess: () => {
          toast({ title: "Job deleted" });
          queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListApplicantsQueryKey() });
          if (selectedJobId === deleteJobId) setSelectedJobId(null);
          setDeleteJobId(null);
        },
        onError: () => toast({ title: "Failed to delete job", variant: "destructive" }),
      },
    );
  };

  const updateApplicant = (id: number, status: string, notes?: string) => {
    updateApplicantMutation.mutate(
      { id, data: { status: status as "applied" | "attended" | "selected" | "rejected", notes } },
      {
        onSuccess: () => {
          toast({ title: `Applicant marked ${status}` });
          queryClient.invalidateQueries({ queryKey: getListApplicantsQueryKey() });
        },
        onError: () => toast({ title: "Update failed", variant: "destructive" }),
      },
    );
  };

  if (jobsLoading || appLoading) {
    return (
      <HrLayout>
        <div className="flex items-center justify-center min-h-[calc(100vh-140px)]">
          <Loader />
        </div>
      </HrLayout>
    );
  }

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black">Interviews</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Job postings, shareable apply links, and applicant pipeline
            </p>
          </div>
          <Button onClick={() => setNewJobOpen(true)} data-testid="button-new-job">
            <Plus size={16} className="mr-2" /> Post Job
          </Button>
        </div>

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Applicants", value: summary.totalApplicants, icon: Users },
              { label: "Attended", value: summary.attended, icon: Briefcase },
              { label: "Selected", value: summary.selected, icon: CheckSquare },
              { label: "Rejected", value: summary.rejected, icon: XSquare },
            ].map(({ label, value, icon: Icon }) => (
              <Card key={label}>
                <CardContent className="p-4 flex items-center gap-3">
                  <Icon size={18} className="text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="text-2xl font-black">{value ?? 0}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="grid lg:grid-cols-5 gap-5">
          <div className="lg:col-span-2 flex flex-col justify-between min-h-[calc(100vh-220px)] lg:min-h-[calc(100vh-240px)] gap-4">
            <div className="space-y-3 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Job Postings</p>
              {jobsLoading ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
              ) : jobs && jobs.length > 0 ? (
                <>
                  {paginatedJobs.map((job) => (
                    <Card
                      key={job.id}
                      onClick={() => setSelectedJobId(job.id)}
                      className={`cursor-pointer transition-colors ${selectedJobId === job.id ? "border-accent bg-accent/5" : "hover:bg-muted/30"}`}
                      data-testid={`job-card-${job.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-sm">{job.title}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{job.departmentName}</p>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <Badge
                              variant={job.status === "open" ? "default" : "secondary"}
                              className={job.status === "open" ? "bg-green-100 text-green-800" : ""}
                            >
                              {job.status}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{job.applicantCount ?? 0} applicants</span>
                          </div>
                        </div>
                        {job.salaryRange && (
                          <p className="text-xs text-muted-foreground mt-2">Salary: {job.salaryRange}</p>
                        )}
                        <div className="flex gap-2 mt-3 pt-3 border-t">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex-1 h-8 text-xs"
                            onClick={(e) => handleShare(job.id, e)}
                            data-testid={`button-share-job-${job.id}`}
                          >
                            <Share2 size={14} className="mr-1" /> Share
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteJobId(job.id);
                            }}
                            data-testid={`button-delete-job-${job.id}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </>
              ) : (
                <Card>
                  <CardContent className="py-10 text-center text-muted-foreground text-sm">
                    No jobs posted yet
                  </CardContent>
                </Card>
              )}
            </div>

            {jobs && jobs.length > PAGE_SIZE && (
              <div className="flex flex-col gap-3 px-1 py-3 sm:flex-row sm:items-center sm:justify-between shrink-0">
                <p className="text-xs text-muted-foreground">
                  Showing {paginatedJobs.length} of {jobs.length} jobs
                </p>
                <Pagination className="mt-2 sm:mt-0">
                  <PaginationPrevious
                    href="#"
                    className={page === 1 ? "pointer-events-none opacity-50" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      if (page > 1) {
                        setPage(page - 1);
                      }
                    }}
                  />
                  <PaginationContent>
                    {Array.from({ length: totalPages }, (_, index) => {
                      const pageNumber = index + 1;
                      return (
                        <PaginationItem key={pageNumber}>
                          <PaginationLink
                            href="#"
                            isActive={pageNumber === page}
                            onClick={(event) => {
                              event.preventDefault();
                              setPage(pageNumber);
                            }}
                          >
                            {pageNumber}
                          </PaginationLink>
                        </PaginationItem>
                      );
                    })}
                  </PaginationContent>
                  <PaginationNext
                    href="#"
                    className={page === totalPages ? "pointer-events-none opacity-50" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      if (page < totalPages) {
                        setPage(page + 1);
                      }
                    }}
                  />
                </Pagination>
              </div>
            )}
          </div>

          <div className="lg:col-span-3 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {selectedJobId ? "Applicants (from shared link & HR)" : "Select a job to view applicants"}
            </p>
            {selectedJobId ? (
              appLoading ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
              ) : applicants && applicants.length > 0 ? (
                <Card>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">Applicant</TableHead>
                          <TableHead className="hidden md:table-cell">Contact</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="pr-4 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {applicants.map((app) => (
                          <TableRow key={app.id} data-testid={`row-applicant-${app.id}`}>
                            <TableCell className="pl-4">
                              <p className="font-medium text-sm">{app.name}</p>
                              <p className="text-xs text-muted-foreground truncate max-w-[180px]">
                                {app.experience ? app.experience.slice(0, 60) : app.email}
                                {app.experience && app.experience.length > 60 ? "…" : ""}
                              </p>
                            </TableCell>
                            <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                              <p>{app.phone}</p>
                              <p className="text-xs">{app.email}</p>
                            </TableCell>
                            <TableCell>{statusBadge(app.status ?? "applied")}</TableCell>
                            <TableCell className="pr-4">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 px-2"
                                  onClick={() => setViewApplicant(app)}
                                  data-testid={`button-view-applicant-${app.id}`}
                                >
                                  <Eye size={14} />
                                </Button>
                                <Select
                                  value={app.status ?? "applied"}
                                  onValueChange={(v) => updateApplicant(app.id, v)}
                                >
                                  <SelectTrigger
                                    className="w-28 h-8 text-xs"
                                    data-testid={`select-applicant-status-${app.id}`}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="applied">Applied</SelectItem>
                                    <SelectItem value="attended">Attended</SelectItem>
                                    <SelectItem value="selected">Selected</SelectItem>
                                    <SelectItem value="rejected">Rejected</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="py-10 text-center text-muted-foreground text-sm">
                    No applicants yet. Share the job link to collect applications.
                  </CardContent>
                </Card>
              )
            ) : (
              <Card className="opacity-50">
                <CardContent className="py-16 text-center text-muted-foreground text-sm">
                  <Briefcase size={32} className="mx-auto mb-3 opacity-30" />
                  <p>Select a job posting to view applicants</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      <Dialog open={newJobOpen} onOpenChange={setNewJobOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Post New Job</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onCreateJob)} className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Job Title *</FormLabel>
                    <FormControl>
                      <Input data-testid="input-job-title" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Department *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-department">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {departments?.map((d) => (
                          <SelectItem key={d.id} value={String(d.id)}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="salaryRange"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Salary Range</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. ₹15,000 - ₹20,000" data-testid="input-salary-range" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea rows={2} data-testid="input-description" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="requirements"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Requirements</FormLabel>
                    <FormControl>
                      <Textarea rows={2} data-testid="input-requirements" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setNewJobOpen(false)} data-testid="button-cancel">
                  Cancel
                </Button>
                <Button type="submit" disabled={createJobMutation.isPending} data-testid="button-post">
                  {createJobMutation.isPending ? "Posting..." : "Post Job"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteJobId !== null} onOpenChange={(open) => !open && setDeleteJobId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete job posting?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the job and all applications submitted for it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-job">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteJob}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-job"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!viewApplicant} onOpenChange={(open) => !open && setViewApplicant(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Application details</DialogTitle>
            <DialogDescription>
              Submitted via shared job link
              {viewApplicant?.jobTitle ? ` · ${viewApplicant.jobTitle}` : ""}
            </DialogDescription>
          </DialogHeader>
          {viewApplicant && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Name</p>
                  <p className="font-medium">{viewApplicant.name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Status</p>
                  {statusBadge(viewApplicant.status ?? "applied")}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Email</p>
                  <p>{viewApplicant.email}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Phone</p>
                  <p>{viewApplicant.phone}</p>
                </div>
              </div>
              {viewApplicant.experience && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Experience</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{viewApplicant.experience}</p>
                </div>
              )}
              {viewApplicant.coverLetter && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Cover letter</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{viewApplicant.coverLetter}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Applied {viewApplicant.createdAt ? new Date(viewApplicant.createdAt).toLocaleString() : "—"}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewApplicant(null)} data-testid="button-close-applicant">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
