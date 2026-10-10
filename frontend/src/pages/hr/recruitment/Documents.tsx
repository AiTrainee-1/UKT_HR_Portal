import { useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useListEmployees } from "@/lib/api-client";
import {
  useDocumentCompletionStats,
  useEmployeeDocuments,
  type EmployeeDocumentCategory,
} from "@/lib/api-client/custom-hooks";
import { ErrorState } from "../career/parts";
import CategoryDialog from "../recruitment-documents/CategoryDialog";
import EmployeeView from "../recruitment-documents/EmployeeView";
import { buildTracker, NO_FILTERS, requiredCategories, type TrackerFilters } from "../recruitment-documents/logic";
import TrackerView from "../recruitment-documents/TrackerView";

type Kind = "staff" | "production";

/** Documents: who still owes which required papers (staff and production), each employee's letters and uploaded files. */
export default function Documents() {
  const { token } = useAuth();
  const [tab, setTab] = useState<Kind>("staff");
  const [filters, setFilters] = useState<TrackerFilters>(NO_FILTERS);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [docTab, setDocTab] = useState<"letters" | "extra">("letters");
  const [activeCategory, setActiveCategory] = useState<EmployeeDocumentCategory | null>(null);

  const employeesQuery = useListEmployees();
  const everyone = useMemo(() => employeesQuery.data ?? [], [employeesQuery.data]);
  const selectedEmployee = everyone.find((e) => e.id === selectedEmployeeId) ?? null;

  const statsQuery = useDocumentCompletionStats(tab);
  const rows = useMemo(() => buildTracker(statsQuery.data, requiredCategories(tab).length), [statsQuery.data, tab]);

  const documentsQuery = useEmployeeDocuments(selectedEmployeeId);
  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);

  function openEmployee(employeeId: number, initialDocTab: "letters" | "extra" = "letters") {
    setSelectedEmployeeId(employeeId);
    setDocTab(initialDocTab);
  }

  return (
    <HrLayout>
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600">
              <FolderOpen size={18} className="text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-black text-gray-900">Documents</h2>
              <p className="mt-0.5 text-sm text-gray-500">
                See who still owes which documents, generate letters, and manage every employee's extra documents.
              </p>
            </div>
          </div>
          {!selectedEmployee && (
            <PillTabs
              items={[
                { value: "staff", label: "Staff" },
                { value: "production", label: "Production" },
              ]}
              value={tab}
              onChange={(v) => {
                setTab(v as Kind);
                setFilters(NO_FILTERS);
              }}
            />
          )}
        </div>

        {selectedEmployee ? (
          <EmployeeView
            employee={selectedEmployee}
            documents={documents}
            documentsLoading={documentsQuery.isLoading}
            docTab={docTab}
            onDocTab={setDocTab}
            onBack={() => {
              setSelectedEmployeeId(null);
              setActiveCategory(null);
            }}
            onOpenCategory={setActiveCategory}
            token={token}
          />
        ) : selectedEmployeeId !== null && employeesQuery.isError ? (
          <ErrorState what="the employee" onRetry={() => employeesQuery.refetch()} testId="employee-error" />
        ) : (
          <TrackerView
            kind={tab}
            rows={rows}
            loading={statsQuery.isLoading || (selectedEmployeeId !== null && employeesQuery.isLoading)}
            failed={statsQuery.isError}
            onRetry={() => statsQuery.refetch()}
            filters={filters}
            onFilters={setFilters}
            everyone={everyone}
            onOpen={openEmployee}
          />
        )}

        {activeCategory && selectedEmployee && (
          <CategoryDialog
            employeeId={selectedEmployee.id}
            employeeName={`${selectedEmployee.firstName} ${selectedEmployee.lastName}`.trim()}
            category={activeCategory}
            documents={documents.filter((d) => d.category === activeCategory)}
            token={token}
            onClose={() => setActiveCategory(null)}
          />
        )}
      </div>
    </HrLayout>
  );
}
