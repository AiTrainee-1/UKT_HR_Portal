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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useListNotifications, useMarkNotificationRead, getListNotificationsQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Bell, CheckCheck, MessageSquare, IndianRupee, Calendar } from "lucide-react";
import Loader from "@/components/Loader";

function typeIcon(type: string) {
  if (type === "salary_complaint") return <IndianRupee size={15} className="text-orange-500" />;
  if (type === "leave_request") return <Calendar size={15} className="text-blue-500" />;
  return <MessageSquare size={15} className="text-muted-foreground" />;
}

function typeLabel(type: string) {
  if (type === "salary_complaint") return "Salary Complaint";
  if (type === "leave_request") return "Leave Request";
  return "General";
}

export default function Notifications() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: notifications, isLoading } = useListNotifications({});
  const mutation = useMarkNotificationRead();

  const unread = notifications?.filter((n) => !n.isRead) ?? [];
  const read = notifications?.filter((n) => n.isRead) ?? [];

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const totalNotifications = notifications?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalNotifications / PAGE_SIZE));
  const paginatedNotifications = notifications ? notifications.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  const paginatedUnread = paginatedNotifications.filter((n) => !n.isRead);
  const paginatedRead = paginatedNotifications.filter((n) => n.isRead);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const markRead = (id: number) => {
    mutation.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
      onError: () => toast({ title: "Failed to mark as read", variant: "destructive" }),
    });
  };

  const markAllRead = () => {
    unread.forEach((n) => markRead(n.id));
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
          <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black">Employee Messages</h2>
            <p className="text-muted-foreground text-sm mt-0.5">{unread.length} unread</p>
          </div>
          {unread.length > 0 && (
            <Button variant="outline" size="sm" onClick={markAllRead} data-testid="button-mark-all-read">
              <CheckCheck size={15} className="mr-2" /> Mark all read
            </Button>
          )}
        </div>

        {notifications && notifications.length > 0 ? (
          <div className="space-y-2">
            {/* Unread */}
            {unread.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold px-1">Unread ({unread.length})</p>
                {paginatedUnread.map((notif) => (
                  <Card key={notif.id} className="border-accent/30 bg-accent/5" data-testid={`notification-${notif.id}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                          {typeIcon(notif.type ?? "general")}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">{notif.employeeName}</span>
                            <Badge variant="outline" className="text-xs">{typeLabel(notif.type ?? "general")}</Badge>
                            <span className="text-xs text-muted-foreground ml-auto">
                              {notif.createdAt ? new Date(notif.createdAt).toLocaleDateString("en-IN") : ""}
                            </span>
                          </div>
                          <p className="text-sm text-foreground mt-1.5 leading-relaxed">{notif.message}</p>
                        </div>
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => markRead(notif.id)}
                          data-testid={`button-read-${notif.id}`}
                          className="flex-shrink-0 text-xs text-muted-foreground"
                        >
                          <CheckCheck size={14} />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Read */}
            {read.length > 0 && (
              <div className="space-y-2 mt-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold px-1">Read ({read.length})</p>
                {paginatedRead.map((notif) => (
                  <Card key={notif.id} className="opacity-60" data-testid={`notification-${notif.id}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                          {typeIcon(notif.type ?? "general")}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">{notif.employeeName}</span>
                            <Badge variant="outline" className="text-xs">{typeLabel(notif.type ?? "general")}</Badge>
                            <span className="text-xs text-muted-foreground ml-auto">
                              {notif.createdAt ? new Date(notif.createdAt).toLocaleDateString("en-IN") : ""}
                            </span>
                          </div>
                          <p className="text-sm text-foreground mt-1.5 leading-relaxed">{notif.message}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Bell size={32} className="mb-3 opacity-30" />
              <p className="font-medium">No messages yet</p>
              <p className="text-sm mt-1">Employee messages will appear here</p>
            </CardContent>
          </Card>
        )}
      </div>

      {notifications && notifications.length > PAGE_SIZE && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t bg-card rounded-lg shadow-sm shrink-0">
          <p className="text-sm text-muted-foreground">
            Showing {paginatedNotifications.length} of {notifications.length} records
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
    </HrLayout>
  );
}
