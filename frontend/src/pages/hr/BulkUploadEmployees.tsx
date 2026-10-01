import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Info, ListChecks, UserCheck, UserMinus, UserPlus, UploadCloud } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { getListEmployeesQueryKey, useListEmployees } from "@/lib/api-client";
import { todayStamp } from "@/lib/exportUtils";
import { cn } from "@/lib/utils";
import CategorySwitch from "./bulk-upload/CategorySwitch";
import { CATEGORIES, STATUS_LABEL } from "./bulk-upload/config";
import EmployeesTable from "./bulk-upload/EmployeesTable";
import { downloadEmployees, downloadTemplate, scopeLabel } from "./bulk-upload/excel";
import { employeesOf, tally } from "./bulk-upload/logic";
import TemplateCard from "./bulk-upload/TemplateCard";
import type { Category, ListStatus } from "./bulk-upload/types";
import UploadFlow from "./bulk-upload/UploadFlow";

type Tab = "add" | ListStatus;

function Step({ n, title, children, accent }: { n: number; title: string; children: ReactNode; accent: string }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black text-white",
              accent,
            )}
          >
            {n}
          </span>
          <h3 className="text-base font-bold text-gray-900">{title}</h3>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

const GUIDE: Record<Tab, string[]> = {
  add: [
    "Pick Staff or Production first: each has its own template, because they are paid differently.",
    "Download the template. Rows starting with SAMPLE are examples and are always skipped.",
    "Only Employee Code and First Name are required. Everything else can be filled in later.",
    "Upload the filled sheet. It is checked first and nothing is saved: you see every row, what would happen and why.",
    "Fix any row that is Invalid or a Duplicate in the sheet and upload again; rows that already went through are reported as Duplicates, so nobody is created twice.",
  ],
  active: [
    "Download the active employees of this kind: it is the same sheet as the template, with their real details and a Status column.",
    "Change only the cells you want to change. A blank cell never erases what is stored.",
    "Set Status to Inactive to retire someone. Delete a row only if you want that employee dealt with: you will be asked what to do.",
    "Upload it back. You see which rows would be updated, unchanged or refused before anything is saved.",
    "If employees are missing from the file you choose for each: leave them, make them Inactive, or delete them with all their data. Nothing is removed unasked.",
  ],
  inactive: [
    "Download the inactive employees of this kind to keep their records tidy or to bring someone back.",
    "Set Status to Active to make an employee active again; they move to the Active list.",
    "Employees missing from the file are left alone unless you choose to delete them (they are already inactive).",
    "The same check-first flow applies: you review every row before it is saved.",
  ],
};

export default function BulkUploadEmployees() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: employees, isLoading } = useListEmployees();

  const [category, setCategory] = useState<Category>("staff");
  const [tab, setTab] = useState<Tab>("add");
  const cfg = CATEGORIES[category];
  const counts = useMemo(() => tally(employees), [employees]);
  const baseColor = category === "staff" ? "#059669" : "#d97706";

  const listFor = (status: ListStatus) => employeesOf(employees, category, status);
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });

  const download = async (status: ListStatus) => {
    try {
      await downloadEmployees(category, status, employees ?? [], user);
    } catch {
      toast({ title: "Could not create the Excel file", variant: "destructive" });
    }
  };

  const status: ListStatus = tab === "inactive" ? "inactive" : "active";
  const inList = listFor(status);

  return (
    <HrLayout>
      <div className="space-y-5 pb-10">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/employees")} aria-label="Back to employees">
            <ArrowLeft size={18} />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-black text-gray-900">Employee Bulk Upload</h2>
            <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
              Add many employees at once, or download your existing ones, edit them in Excel and upload them back. Staff
              and Production have their own sheets, and every file is checked before anything is saved.
            </p>
          </div>
        </div>

        <CategorySwitch value={category} counts={counts} loading={isLoading} onChange={setCategory} />

        <Card className="border-0 shadow-sm">
          <CardContent className="space-y-5 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PillTabs
                value={tab}
                onChange={(v) => setTab(v as Tab)}
                baseColor={baseColor}
                items={[
                  {
                    value: "add",
                    label: (
                      <>
                        <span className="hidden sm:inline">Add new employees</span>
                        <span className="sm:hidden">Add new</span>
                      </>
                    ),
                    icon: <UserPlus size={13} />,
                  },
                  {
                    value: "active",
                    label: (
                      <>
                        <span className="hidden sm:inline">Active employees</span>
                        <span className="sm:hidden">Active</span>
                      </>
                    ),
                    count: counts[category].active,
                    icon: <UserCheck size={13} />,
                  },
                  {
                    value: "inactive",
                    label: (
                      <>
                        <span className="hidden sm:inline">Inactive employees</span>
                        <span className="sm:hidden">Inactive</span>
                      </>
                    ),
                    count: counts[category].inactive,
                    icon: <UserMinus size={13} />,
                  },
                ]}
              />
              <p className={cn("text-xs font-semibold", cfg.accent.text)}>
                {cfg.label}: {cfg.tagline.toLowerCase()}
              </p>
            </div>

            {tab === "add" ? (
              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
                <div className="min-w-0 lg:col-span-2">
                  <Step n={1} title={`Download the ${cfg.label} template`} accent={cfg.accent.solid.split(" ")[0]}>
                    <TemplateCard
                      category={category}
                      fileName={`${cfg.label}_Employee_Template_${scopeLabel(user)}_${todayStamp()}.xlsx`}
                      onDownload={() => void downloadTemplate(category, user)}
                    />
                  </Step>
                </div>
                <div className="min-w-0 lg:col-span-3">
                  <Step n={2} title="Upload the filled sheet" accent={cfg.accent.solid.split(" ")[0]}>
                    <UploadFlow
                      key={`add-${category}`}
                      kind="create"
                      category={category}
                      status="active"
                      onApplied={refresh}
                      onViewEmployees={() => navigate("/hr/employees")}
                    />
                  </Step>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
                  <div className="min-w-0 lg:col-span-2">
                    <Step
                      n={1}
                      title={`Download ${STATUS_LABEL[status].toLowerCase()} ${cfg.label} employees`}
                      accent={cfg.accent.solid.split(" ")[0]}
                    >
                      <p className="text-sm text-muted-foreground">
                        One Excel file with the {inList.length} {STATUS_LABEL[status].toLowerCase()}{" "}
                        {cfg.label.toLowerCase()} employee
                        {inList.length === 1 ? "" : "s"} you can see, in the same columns as the template plus a{" "}
                        <b>Status</b> column. Edit it and upload it in step 2.
                      </p>
                      <Button
                        className={cn("w-full gap-2 text-white", cfg.accent.solid)}
                        disabled={inList.length === 0}
                        onClick={() => void download(status)}
                        data-testid={`download-${category}-${status}`}
                      >
                        <Download size={15} /> Download {STATUS_LABEL[status].toLowerCase()} {cfg.label.toLowerCase()}{" "}
                        employees
                      </Button>
                      {inList.length === 0 && (
                        <p className="text-xs text-gray-500">
                          There are no {STATUS_LABEL[status].toLowerCase()} {cfg.label.toLowerCase()} employees yet.
                        </p>
                      )}
                      <p className="flex items-start gap-1.5 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
                        <Info size={13} className="mt-0.5 shrink-0" />
                        Rows are matched by Employee Code. Blank cells never erase stored data, and only cells with new
                        values are written.
                      </p>
                    </Step>
                  </div>
                  <div className="min-w-0 lg:col-span-3">
                    <Step n={2} title="Upload the edited file" accent={cfg.accent.solid.split(" ")[0]}>
                      <UploadFlow
                        key={`${status}-${category}`}
                        kind="update"
                        category={category}
                        status={status}
                        disabled={inList.length === 0}
                        onApplied={refresh}
                        onViewEmployees={() => navigate("/hr/employees")}
                      />
                    </Step>
                  </div>
                </div>

                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-gray-900">
                    <UploadCloud size={14} className={cfg.accent.text} /> What is in the{" "}
                    {STATUS_LABEL[status].toLowerCase()} {cfg.label.toLowerCase()} download
                  </p>
                  <EmployeesTable
                    key={`${status}-${category}`}
                    employees={inList}
                    category={category}
                    loading={isLoading}
                    emptyText={`No ${STATUS_LABEL[status].toLowerCase()} ${cfg.label.toLowerCase()} employees.`}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <details className="group" open={false}>
              <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-bold text-gray-900">
                <ListChecks size={16} className={cfg.accent.text} /> How this works
              </summary>
              <ol className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                {GUIDE[tab].map((step, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span
                      className={cn(
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-black",
                        cfg.accent.soft,
                        cfg.accent.text,
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="text-gray-600">{step}</span>
                  </li>
                ))}
              </ol>
            </details>
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}
