import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  CreditCard,
  Factory,
  FileBadge,
  FileMinus,
  FileSignature,
  FileClock,
  Fingerprint,
  GraduationCap,
  Vote,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import {
  EMPLOYEE_DOCUMENT_CATEGORIES,
  type EmployeeDocumentCategory,
  type EmployeeDocumentItem,
} from "@/lib/api-client/custom-hooks";
import type { Employee } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatDate } from "../career/dates";
import { Chip } from "../career/parts";
import { categoryStatus, completion, requiredCategories } from "./logic";
import LettersTab from "./LettersTab";

export const CATEGORY_ICONS: Record<EmployeeDocumentCategory, LucideIcon> = {
  pan_card: CreditCard,
  aadhaar_card: Fingerprint,
  educational_certificate: GraduationCap,
  voter_id_or_birth_certificate: Vote,
  bank_passbook: Wallet,
  offer_letter: FileSignature,
  experience_letter: FileClock,
  resignation_letter: FileMinus,
  staff_letter: FileBadge,
  production_employee_documents: Factory,
};

// The system already generates Offer/Experience/Resignation letters on demand (Company Documents Settings
// templates), so there is no reason to also let HR upload manual copies of them here. Extra Documents keeps only the
// categories that have no generator: ID proofs and scanned/signed paperwork.
const EXTRA_DOCUMENT_CATEGORIES = EMPLOYEE_DOCUMENT_CATEGORIES.filter(
  (c) => c.value !== "offer_letter" && c.value !== "experience_letter" && c.value !== "resignation_letter",
);

type Props = {
  employee: Employee;
  documents: EmployeeDocumentItem[];
  documentsLoading: boolean;
  docTab: "letters" | "extra";
  onDocTab: (tab: "letters" | "extra") => void;
  onBack: () => void;
  onOpenCategory: (category: EmployeeDocumentCategory) => void;
  token: string | null;
};

/** One employee: who they are, how complete their paperwork is, the letters to generate and the files on record. */
export default function EmployeeView({
  employee,
  documents,
  documentsLoading,
  docTab,
  onDocTab,
  onBack,
  onOpenCategory,
  token,
}: Props) {
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const required = requiredCategories(employee.employmentType);
  const done = completion(documents, employee.employmentType);
  const percent = Math.round((done.present / done.required) * 100);
  const labelOf = (c: EmployeeDocumentCategory) => EMPLOYEE_DOCUMENT_CATEGORIES.find((x) => x.value === c)?.label ?? c;

  return (
    <div className="space-y-4" data-testid="employee-view">
      <Card className="rounded-2xl">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="Back to all employees"
              data-testid="back-to-list"
            >
              <ChevronLeft size={18} />
            </Button>
            <EmployeeAvatar photoUrl={employee.photoUrl} name={name} size={44} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-base font-bold text-gray-900">
                {name}
                <span className="font-mono text-xs font-normal text-gray-400">{employee.employeeCode}</span>
                {employee.employmentType && (
                  <Chip className="border-blue-200 bg-blue-50 capitalize text-blue-700">{employee.employmentType}</Chip>
                )}
                {employee.status !== "active" && (
                  <Chip className="border-gray-200 bg-gray-100 capitalize text-gray-600">{employee.status}</Chip>
                )}
              </p>
              <p className="text-xs text-gray-500">
                {[employee.designationTitle, employee.departmentName, employee.branchName]
                  .filter(Boolean)
                  .join(" · ") || "No designation or department"}
                {employee.joinDate ? ` · joined ${formatDate(employee.joinDate)}` : ""}
              </p>
            </div>
            <div className="w-full sm:w-56" data-testid="employee-completion">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-semibold text-gray-700">Required documents</span>
                <span className={cn("font-bold", done.missing.length === 0 ? "text-emerald-600" : "text-amber-600")}>
                  {documentsLoading ? "…" : `${done.present} of ${done.required}`}
                </span>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-100"
                role="progressbar"
                aria-valuenow={documentsLoading ? 0 : percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Required documents on file"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    done.missing.length === 0 ? "bg-emerald-500" : "bg-amber-400",
                  )}
                  style={{ width: `${documentsLoading ? 0 : percent}%` }}
                />
              </div>
            </div>
          </div>
          <PillTabs
            items={[
              { value: "letters", label: "Letters" },
              {
                value: "extra",
                label: "Extra Documents",
                count: documentsLoading ? undefined : done.missing.length || undefined,
              },
            ]}
            value={docTab}
            onChange={(v) => onDocTab(v as "letters" | "extra")}
          />
        </CardContent>
      </Card>

      {docTab === "letters" ? (
        <LettersTab
          employeeId={employee.id}
          joinDate={employee.joinDate}
          designation={employee.designationTitle}
          department={employee.departmentName}
          token={token}
        />
      ) : (
        <div className="space-y-3">
          {!documentsLoading &&
            (done.missing.length === 0 ? (
              <p
                className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"
                data-testid="docs-complete"
              >
                <CheckCircle2 size={14} className="shrink-0" /> Every required document is on file.
              </p>
            ) : (
              <p
                className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                data-testid="docs-missing"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  <b>
                    {done.missing.length} required {done.missing.length === 1 ? "document is" : "documents are"}{" "}
                    missing:
                  </b>{" "}
                  {done.missing.map(labelOf).join(", ")}.
                </span>
              </p>
            ))}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {EXTRA_DOCUMENT_CATEGORIES.map(({ value, label }) => {
              const Icon = CATEGORY_ICONS[value];
              const { count, latest } = categoryStatus(documents, value);
              const isRequired = required.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => onOpenCategory(value)}
                  className="text-left"
                  data-testid={`category-${value}`}
                  aria-label={`${label}: ${count === 0 ? "no files" : `${count} file${count === 1 ? "" : "s"}`}${isRequired ? ", required" : ""}`}
                >
                  <Card
                    className={cn(
                      "h-full rounded-2xl border-2 transition-shadow hover:shadow-md",
                      count > 0
                        ? "border-emerald-100"
                        : isRequired
                          ? "border-amber-200 bg-amber-50/40"
                          : "border-transparent",
                    )}
                  >
                    <CardContent className="flex h-full flex-col gap-2 p-4">
                      <div className="flex items-start justify-between">
                        <div
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-lg",
                            count > 0 ? "bg-emerald-50" : "bg-indigo-50",
                          )}
                        >
                          <Icon size={16} className={count > 0 ? "text-emerald-600" : "text-indigo-600"} />
                        </div>
                        {count > 0 ? (
                          <CheckCircle2 size={16} className="text-emerald-500" aria-hidden />
                        ) : isRequired ? (
                          <Chip className="border-amber-300 bg-white text-amber-700">Missing</Chip>
                        ) : null}
                      </div>
                      <p className="text-sm font-semibold leading-tight text-gray-800">{label}</p>
                      <p className="text-xs text-gray-400">
                        {count === 0 ? "No files" : `${count} file${count !== 1 ? "s" : ""}`}
                        {latest ? ` · ${formatDate(latest)}` : ""}
                      </p>
                      {!isRequired && <p className="text-[10px] uppercase tracking-wide text-gray-300">Optional</p>}
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
