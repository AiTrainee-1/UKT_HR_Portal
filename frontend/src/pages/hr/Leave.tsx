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
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useListLeaveRequests, useUpdateLeaveStatus, getListLeaveRequestsQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, XCircle } from "lucide-react";
import Loader from "@/components/Loader";

type LeaveStatus = "pending" | "approved" | "rejected";

function statusBadge(status: string) {
  if (status === "approved") return <Badge className="bg-green-100 text-green-800">Approved</Badge>;
  if (status === "rejected") return <Badge className="bg-red-100 text-red-800">Rejected</Badge>;
  return <Badge className="bg-amber-100 text-amber-800">Pending</Badge>;
}

export default function Leave() {
  const [tab, setTab] = useState<LeaveStatus>("pending");
  const [actionLeave, setActionLeave] = useState<{ id: number; action: "approved" | "rejected" } | null>(null);
  const [hrComment, setHrComment] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: leaves, isLoading } = useListLeaveRequests({ status: tab });
  const mutation = useUpdateLeaveStatus();

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const totalLeaves = leaves?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalLeaves / PAGE_SIZE));
  const paginatedLeaves = leaves ? leaves.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  useEffect(() => {
    setPage(1);
  }, [tab, totalLeaves]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const handleAction = () => {
    if (!actionLeave) return;
    mutation.mutate(
      { id: actionLeave.id, data: { status: actionLeave.action, hrComment } },
      {
        onSuccess: () => {
          toast({ title: `Leave ${actionLeave.action}` });
          queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
          setActionLeave(null);
          setHrComment("");
        },
        onError: () => toast({ title: "Action failed", variant: "destructive" }),
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

  return (
    <HrLayout>
      <div className="min-h-[calc(100vh-140px)] flex flex-col justify-between gap-6">
        <div className="space-y-5 flex-1">
          <div>
          <h2 className="text-2xl font-black">Leave Requests</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Review and manage employee leave</p>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as LeaveStatus)}>
          <PillTabs
            items={[
              { value: "pending", label: "Pending" },
              { value: "approved", label: "Approved" },
              { value: "rejected", label: "Rejected" },
            ]}
            value={tab}
            onChange={(v) => setTab(v as LeaveStatus)}
          />

          {(["pending", "approved", "rejected"] as LeaveStatus[]).map((tabVal) => (
            <TabsContent key={tabVal} value={tabVal}>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Employee</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>From</TableHead>
                        <TableHead>To</TableHead>
                        <TableHead className="hidden md:table-cell">Reason</TableHead>
                        <TableHead>Status</TableHead>
                        {tab === "pending" && <TableHead className="pr-4 text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-16">
                            <Loader />
                          </TableCell>
                        </TableRow>
                      ) : leaves && leaves.length > 0 ? (
                        paginatedLeaves.map((leave) => (
                          <TableRow key={leave.id} data-testid={`row-leave-${leave.id}`}>
                            <TableCell className="pl-4 font-medium text-sm">{leave.employeeName}</TableCell>
                            <TableCell className="capitalize text-sm text-muted-foreground">{leave.type}</TableCell>
                            <TableCell className="text-sm">{leave.startDate}</TableCell>
                            <TableCell className="text-sm">{leave.endDate}</TableCell>
                            <TableCell className="hidden md:table-cell text-sm text-muted-foreground max-w-48 truncate">{leave.reason}</TableCell>
                            <TableCell>{statusBadge(leave.status ?? "pending")}</TableCell>
                            {tab === "pending" && (
                              <TableCell className="pr-4 text-right">
                                <div className="flex gap-1 justify-end">
                                  <Button size="sm" variant="ghost" className="text-green-600 hover:text-green-700"
                                    data-testid={`button-approve-${leave.id}`}
                                    onClick={() => { setActionLeave({ id: leave.id, action: "approved" }); setHrComment(""); }}>
                                    <CheckCircle size={15} className="mr-1" /> Approve
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive/80"
                                    data-testid={`button-reject-${leave.id}`}
                                    onClick={() => { setActionLeave({ id: leave.id, action: "rejected" }); setHrComment(""); }}>
                                    <XCircle size={15} className="mr-1" /> Reject
                                  </Button>
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={tab === "pending" ? 7 : 6} className="text-center py-12 text-muted-foreground">
                            No {tabVal} leave requests
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>
      </div>

        {leaves && leaves.length > PAGE_SIZE && (
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t bg-card rounded-lg shadow-sm shrink-0">
            <p className="text-sm text-muted-foreground">
              Showing {paginatedLeaves.length} of {leaves.length} records
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

      <Dialog open={!!actionLeave} onOpenChange={() => { setActionLeave(null); setHrComment(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionLeave?.action === "approved" ? "Approve" : "Reject"} Leave Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="hr-comment">HR Comment (optional)</Label>
            <Textarea
              id="hr-comment"
              placeholder="Add a note for the employee..."
              value={hrComment}
              onChange={(e) => setHrComment(e.target.value)}
              data-testid="input-hr-comment"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionLeave(null)} data-testid="button-cancel">Cancel</Button>
            <Button
              onClick={handleAction}
              disabled={mutation.isPending}
              className={actionLeave?.action === "approved" ? "bg-green-600 hover:bg-green-700" : "bg-destructive hover:bg-destructive/90"}
              data-testid="button-confirm-action"
            >
              {mutation.isPending ? "Processing..." : `Confirm ${actionLeave?.action}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
