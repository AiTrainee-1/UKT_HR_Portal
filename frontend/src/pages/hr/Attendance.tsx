import { useEffect, useMemo, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { ChartContainer } from "@/components/ui/chart";
import { BarChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  useListAttendance, useRecordAttendance, useListEmployees, getListAttendanceQueryKey
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import Loader from "@/components/Loader";

const schema = z.object({
  employeeId: z.string().min(1, "Employee required"),
  date: z.string().min(1, "Date required"),
  hoursWorked: z.string().optional(),
  notes: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

export default function Attendance() {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(true);
  const [empFilter, setEmpFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);

  const { data: records, isLoading } = useListAttendance({
    employeeId: empFilter !== "all" ? Number(empFilter) : undefined,
    year: yearFilter ? Number(yearFilter) : undefined,
  });
  const { data: employees } = useListEmployees({});
  const mutation = useRecordAttendance();

  const PAGE_SIZE = 10;
  const totalRecords = records?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  const paginatedRecords = records ? records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];

  useEffect(() => {
    setPage(1);
  }, [empFilter, yearFilter]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const totalEmployees = employees?.length ?? 0;
  const presentToday = records?.reduce((count, rec) => (rec.date === today && rec.present ? count + 1 : count), 0) ?? 0;
  const recordedToday = records?.filter((rec) => rec.date === today).length ?? 0;
  const absentToday = records?.reduce((count, rec) => (rec.date === today && !rec.present ? count + 1 : count), 0) ?? 0;
  const attendanceCompletion = totalEmployees > 0 ? Math.round((presentToday / totalEmployees) * 100) : 0;

  const attendanceTrend = useMemo(() => {
    if (!records?.length || totalEmployees === 0) {
      return [];
    }

    const grouped = new Map<string, { date: string; present: number; absent: number }>();

    records.forEach((rec) => {
      const existing = grouped.get(rec.date) ?? { date: rec.date, present: 0, absent: 0 };
      if (rec.present) {
        existing.present += 1;
      } else {
        existing.absent += 1;
      }
      grouped.set(rec.date, existing);
    });

    return Array.from(grouped.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-7)
      .map((item) => ({
        ...item,
        absent: item.absent,
      }));
  }, [records, totalEmployees]);

  const weeklyAttendance = useMemo(() => {
    if (!records?.length || totalEmployees === 0) return [];

    const weeklyMap = new Map<string, { week: string; present: number; absent: number }>();
    records
      .map((rec) => ({ ...rec, dateObj: new Date(rec.date) }))
      .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
      .forEach((rec) => {
        const start = new Date(rec.dateObj);
        const dayOfWeek = start.getDay();
        start.setDate(start.getDate() - dayOfWeek);
        start.setHours(0, 0, 0, 0);
        const key = start.toISOString().slice(0, 10);
        const label = `${String(start.getDate()).padStart(2, "0")}/${String(start.getMonth() + 1).padStart(2, "0")}`;
        const existing = weeklyMap.get(key) ?? { week: label, present: 0, absent: 0 };
        if (rec.present) {
          existing.present += 1;
        } else {
          existing.absent += 1;
        }
        weeklyMap.set(key, existing);
      });

    const weeks = Array.from(weeklyMap.entries())
      .sort(([aKey], [bKey]) => aKey.localeCompare(bKey))
      .map(([, value]) => value);
    return weeks.slice(-4).map((item, index, array) => ({
      ...item,
      absent: item.absent,
      change: index === 0 ? 0 : item.present - array[index - 1].present,
    }));
  }, [records, totalEmployees]);

  const monthlyAttendance = useMemo(() => {
    if (!records?.length || totalEmployees === 0) return [];

    const monthlyMap = new Map<string, { month: string; present: number; absent: number }>();
    records
      .map((rec) => ({ ...rec, dateObj: new Date(rec.date) }))
      .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
      .forEach((rec) => {
        const date = rec.dateObj;
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        const label = date.toLocaleString("en-IN", { month: "short", year: "numeric" });
        const existing = monthlyMap.get(key) ?? { month: label, present: 0, absent: 0 };
        if (rec.present) {
          existing.present += 1;
        } else {
          existing.absent += 1;
        }
        monthlyMap.set(key, existing);
      });

    const months = Array.from(monthlyMap.entries())
      .sort(([aKey], [bKey]) => aKey.localeCompare(bKey))
      .map(([, value]) => value);
    return months.slice(-6).map((item, index, array) => ({
      ...item,
      absent: item.absent,
      change: index === 0 ? 0 : item.present - array[index - 1].present,
    }));
  }, [records, totalEmployees]);

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { date: today, hoursWorked: "8" },
  });

  const onSubmit = (data: FormData) => {
    mutation.mutate(
      {
        data: {
          employeeId: Number(data.employeeId),
          date: data.date,
          present,
          hoursWorked: data.hoursWorked ? Number(data.hoursWorked) : undefined,
          notes: data.notes,
        }
      },
      {
        onSuccess: () => {
          toast({ title: "Attendance recorded" });
          queryClient.invalidateQueries({ queryKey: getListAttendanceQueryKey() });
          setOpen(false);
          form.reset({ date: today, hoursWorked: "8" });
        },
        onError: (err: unknown) => {
          const msg = (err as { data?: { error?: string } })?.data?.error ?? "Failed to record attendance.";
          toast({ title: "Error", description: msg, variant: "destructive" });
        },
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
          <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black">Attendance</h2>
            <p className="text-muted-foreground text-sm mt-0.5">{records?.length ?? 0} records</p>
          </div>
          <Button onClick={() => setOpen(true)} data-testid="button-record-attendance">
            <Plus size={16} className="mr-2" /> Record Attendance
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_1.25fr]">
          <Card>
            <CardContent className="p-4 space-y-4">
              <div>
                <p className="text-sm uppercase tracking-wider text-muted-foreground">Today's attendance</p>
                <p className="text-3xl font-black mt-2">{presentToday} of {totalEmployees}</p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg border border-border bg-muted p-3 text-center">
                  <p className="text-muted-foreground">Present</p>
                  <p className="mt-2 text-lg font-semibold text-emerald-700">{presentToday}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted p-3 text-center">
                  <p className="text-muted-foreground">Absent</p>
                  <p className="mt-2 text-lg font-semibold text-rose-700">{absentToday}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted p-3 text-center">
                  <p className="text-muted-foreground">Completion</p>
                  <p className="mt-2 text-lg font-semibold">{attendanceCompletion}%</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm uppercase tracking-wider text-muted-foreground">Present vs Absent</p>
                  <p className="text-xs text-muted-foreground">Based on total employee count</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black">{attendanceCompletion}%</p>
                </div>
              </div>
              <ChartContainer
                config={{ present: { color: "#22c55e" }, absent: { color: "#f59e0b" } }}
                className="h-56"
              >
                <PieChart>
                  <Pie
                    data={[
                      { name: "Present", value: presentToday },
                      { name: "Absent", value: absentToday },
                    ]}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={42}
                    outerRadius={72}
                    paddingAngle={4}
                    labelLine={false}
                    label={({ percent }) => `${Math.round(percent * 100)}%`}
                  >
                    <Cell fill="#22c55e" />
                    <Cell fill="#f59e0b" />
                  </Pie>
                  <Tooltip formatter={(value: number) => [value, "Employees"]} />
                </PieChart>
              </ChartContainer>
              <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
                <div className="rounded-lg border border-border bg-muted p-3">
                  <p className="text-muted-foreground">Present</p>
                  <p className="mt-2 font-semibold text-emerald-700">{presentToday}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted p-3">
                  <p className="text-muted-foreground">Absent</p>
                  <p className="mt-2 font-semibold text-rose-700">{absentToday}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm uppercase tracking-wider text-muted-foreground">Last 7 days attendance</p>
                <p className="text-xs text-muted-foreground">Present employees versus total headcount</p>
              </div>
              <p className="text-sm text-muted-foreground">{totalEmployees} total employees</p>
            </div>
            {attendanceTrend.length > 0 ? (
              <ChartContainer
                config={{ present: { color: "#22c55e" }, absent: { color: "#f59e0b" } }}
                className="h-72"
              >
                <BarChart data={attendanceTrend} margin={{ top: 8, right: 0, left: -12, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(value) => value.slice(-5)} />
                  <YAxis allowDecimals={false} />
                  <Tooltip formatter={(value: number) => [value, "Employees"]} />
                  <Bar dataKey="present" stackId="a" fill="#22c55e" />
                  <Bar dataKey="absent" stackId="a" fill="#f59e0b" />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="flex h-72 items-center justify-center rounded-lg border border-border bg-muted text-sm text-muted-foreground">
                No attendance data available for charting.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardContent className="p-4">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm uppercase tracking-wider text-muted-foreground">Weekly attendance diff</p>
                  <p className="text-xs text-muted-foreground">Last 4 weeks present versus absent</p>
                </div>
                <p className="text-sm text-muted-foreground">Total employees: {totalEmployees}</p>
              </div>
              {weeklyAttendance.length > 0 ? (
                <ChartContainer
                  config={{ present: { color: "#22c55e" }, absent: { color: "#f59e0b" }, change: { color: "#0ea5e9" } }}
                  className="h-72"
                >
                  <BarChart data={weeklyAttendance} margin={{ top: 8, right: 0, left: -12, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="week" />
                    <YAxis allowDecimals={false} />
                    <Tooltip formatter={(value: number) => [value, "Employees"]} />
                    <Bar dataKey="present" stackId="a" fill="#22c55e" />
                    <Bar dataKey="absent" stackId="a" fill="#f59e0b" />
                    <Line type="monotone" dataKey="change" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 3 }} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="flex h-72 items-center justify-center rounded-lg border border-border bg-muted text-sm text-muted-foreground">
                  No weekly attendance data available.
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm uppercase tracking-wider text-muted-foreground">Monthly attendance diff</p>
                  <p className="text-xs text-muted-foreground">Last 6 months present versus absent</p>
                </div>
                <p className="text-sm text-muted-foreground">Total employees: {totalEmployees}</p>
              </div>
              {monthlyAttendance.length > 0 ? (
                <ChartContainer
                  config={{ present: { color: "#22c55e" }, absent: { color: "#f59e0b" }, change: { color: "#0ea5e9" } }}
                  className="h-72"
                >
                  <BarChart data={monthlyAttendance} margin={{ top: 8, right: 0, left: -12, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" />
                    <YAxis allowDecimals={false} />
                    <Tooltip formatter={(value: number) => [value, "Employees"]} />
                    <Bar dataKey="present" stackId="a" fill="#22c55e" />
                    <Bar dataKey="absent" stackId="a" fill="#f59e0b" />
                    <Line type="monotone" dataKey="change" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 3 }} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="flex h-72 items-center justify-center rounded-lg border border-border bg-muted text-sm text-muted-foreground">
                  No monthly attendance data available.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="p-4 flex flex-wrap gap-3">
            <div className="w-64">
              <EmployeeSearchSelect
                employees={employees}
                value={empFilter}
                onChange={setEmpFilter}
                allowAll={true}
                allPlaceholder="All Employees"
                dataTestId="select-employee"
              />
            </div>
            <Input
              type="number"
              className="w-28"
              placeholder="Year"
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
              data-testid="input-year-filter"
            />
            {(empFilter !== "all") && (
              <Button variant="ghost" size="sm" onClick={() => { setEmpFilter("all"); }} data-testid="button-clear-filters">
                Clear
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Employee</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead className="hidden md:table-cell pr-4">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>{Array.from({ length: 5 }).map((_, j) => <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>)}</TableRow>
                  ))
                ) : records && records.length > 0 ? (
                  paginatedRecords.map((rec) => (
                    <TableRow key={rec.id} data-testid={`row-attendance-${rec.id}`}>
                      <TableCell className="pl-4 font-medium text-sm">
                        {employees?.find((e) => e.id === rec.employeeId)
                          ? `${employees.find((e) => e.id === rec.employeeId)!.firstName} ${employees.find((e) => e.id === rec.employeeId)!.lastName}`
                          : `Employee #${rec.employeeId}`}
                      </TableCell>
                      <TableCell className="text-sm">{rec.date}</TableCell>
                      <TableCell>
                        <Badge className={rec.present ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                          {rec.present ? "Present" : "Absent"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{rec.hoursWorked ?? "—"}</TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground pr-4">{rec.notes ?? "—"}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={5} className="text-center py-12 text-muted-foreground">No attendance records</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

        {records && records.length > PAGE_SIZE && (
          <div className="flex flex-row gap-3 px-4 py-3 items-center justify-between border-t bg-card rounded-lg shadow-sm shrink-0">
            <p className="text-sm text-muted-foreground">
              Showing {paginatedRecords.length} of {records.length} records
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
                {(() => {
                  const visible = 3; // show at most 3 page numbers
                  if (totalPages <= visible) {
                    return Array.from({ length: totalPages }, (_, index) => {
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
                    });
                  }

                  let start = Math.max(1, page - Math.floor(visible / 2));
                  let end = Math.min(totalPages, start + visible - 1);
                  if (end - start + 1 < visible) {
                    start = Math.max(1, end - visible + 1);
                  }

                  const items = [] as React.JSX.Element[];
                  for (let p = start; p <= end; p++) {
                    const pageNumber = p;
                    items.push(
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
                  }

                  return items;
                })()}
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Record Attendance</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="employeeId" render={({ field }) => (
                <FormItem className="flex flex-col"><FormLabel>Employee</FormLabel>
                  <FormControl>
                    <EmployeeSearchSelect
                      employees={employees}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Select employee"
                      dataTestId="select-employee-form"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="date" render={({ field }) => (
                <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" data-testid="input-date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="flex items-center gap-3">
                <Switch checked={present} onCheckedChange={setPresent} id="present-switch" data-testid="switch-present" />
                <Label htmlFor="present-switch" className="font-medium">{present ? "Present" : "Absent"}</Label>
              </div>
              {present && (
                <FormField control={form.control} name="hoursWorked" render={({ field }) => (
                  <FormItem><FormLabel>Hours Worked</FormLabel><FormControl><Input type="number" min="0" max="24" data-testid="input-hours" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel">Cancel</Button>
                <Button type="submit" disabled={mutation.isPending} data-testid="button-save">
                  {mutation.isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
