import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { FolderOpen } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { PillTabs } from "@/components/ui/pill-tabs";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useListEmployeesLite } from "@/lib/api-client";
import {
  useDocumentCompletionStats,
  useEmployeeDocuments,
  type EmployeeDocumentCategory,
} from "@/lib/api-client/custom-hooks";
import { moduleForPath } from "@/lib/permission-modules";
import { ViewOnlyTabNote, pickVisible, useLevel, useViewOnlyLock, visibleItems } from "@/lib/tab-access";
import { ErrorState } from "../career/parts";
import CategoryDialog from "../recruitment-documents/CategoryDialog";
import EmployeeView from "../recruitment-documents/EmployeeView";
import { buildTracker, NO_FILTERS, requiredCategories, type TrackerFilters } from "../recruitment-documents/logic";
import TrackerView from "../recruitment-documents/TrackerView";

type Kind = "staff" | "production";
type DocTab = "letters" | "extra";

// Each part's own key (Account Management -> Roles & Permissions -> Recruitment -> Documents).
const KINDS: readonly Kind[] = ["staff", "production"];
const KIND_KEY: Record<Kind, string> = {
  staff: "recruitment.documents.staff",
  production: "recruitment.documents.production",
};
const EMPLOYEE_KEY = "recruitment.documents.employee";
const DOC_TABS: readonly DocTab[] = ["letters", "extra"];
const DOC_TAB_KEY: Record<DocTab, string> = {
  letters: "recruitment.documents.employee.letters",
  extra: "recruitment.documents.employee.extra",
};

/** Documents: who still owes which required papers (staff and production), each employee's letters and uploaded files. */
export default function Documents() {
  const { token, user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  // Only the tabs this role may see: a hidden tab is never shown (or fetched).
  const visibleKinds = visibleItems(KINDS, (k) => KIND_KEY[k], level);
  const [askedTab, setTab] = useState<Kind>("staff");
  const tab = pickVisible(askedTab, visibleKinds);
  // Opening one employee's documents is a key of its own: without it the list has no Open control.
  const canOpenEmployee = level(EMPLOYEE_KEY) !== "hidden";
  const visibleDocTabs = visibleItems(DOC_TABS, (t) => DOC_TAB_KEY[t], level);
  const [filters, setFilters] = useState<TrackerFilters>(NO_FILTERS);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [askedDocTab, setDocTab] = useState<DocTab>("letters");
  const docTab = pickVisible(askedDocTab, visibleDocTabs);
  const [activeCategory, setActiveCategory] = useState<EmployeeDocumentCategory | null>(null);

  const employeesQuery = useListEmployeesLite();
  const everyone = useMemo(() => employeesQuery.data ?? [], [employeesQuery.data]);
  const openId = canOpenEmployee ? selectedEmployeeId : null;
  const selectedEmployee = everyone.find((e) => e.id === openId) ?? null;

  // The part on screen: one employee's sub-tab, else the Staff / Production list. When this role may only VIEW it on a
  // page it may edit, its change buttons are locked (HrLayout locks a View-only page).
  const shownKey = selectedEmployee
    ? visibleDocTabs.length > 0
      ? DOC_TAB_KEY[docTab]
      : EMPLOYEE_KEY
    : visibleKinds.length > 0
      ? KIND_KEY[tab]
      : null;
  const partViewOnly =
    !!shownKey && !isRouteViewOnly(user, location, moduleForPath(location)) && level(shownKey) === "view";
  useViewOnlyLock(partViewOnly, tab, openId, docTab);

  const statsQuery = useDocumentCompletionStats(tab, visibleKinds.length > 0);
  const rows = useMemo(() => buildTracker(statsQuery.data, requiredCategories(tab).length), [statsQuery.data, tab]);

  const documentsQuery = useEmployeeDocuments(openId);
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
          {!selectedEmployee && visibleKinds.length > 0 && (
            <PillTabs
              items={visibleItems(
                [
                  { value: "staff", label: "Staff" },
                  { value: "production", label: "Production" },
                ],
                (t) => KIND_KEY[t.value as Kind],
                level,
              )}
              value={tab}
              onChange={(v) => {
                setTab(v as Kind);
                setFilters(NO_FILTERS);
              }}
            />
          )}
        </div>

        <ViewOnlyTabNote show={partViewOnly} />

        {selectedEmployee ? (
          <EmployeeView
            employee={selectedEmployee}
            documents={documents}
            documentsLoading={documentsQuery.isLoading}
            docTab={docTab}
            onDocTab={setDocTab}
            visibleDocTabs={visibleDocTabs}
            onBack={() => {
              setSelectedEmployeeId(null);
              setActiveCategory(null);
            }}
            onOpenCategory={setActiveCategory}
            token={token}
          />
        ) : openId !== null && employeesQuery.isError ? (
          <ErrorState what="the employee" onRetry={() => employeesQuery.refetch()} testId="employee-error" />
        ) : visibleKinds.length === 0 ? (
          <p
            className="rounded-2xl border bg-white p-6 text-center text-sm text-muted-foreground"
            data-testid="documents-nothing-open"
          >
            Nothing on this page is open to your role.
          </p>
        ) : (
          <TrackerView
            kind={tab}
            rows={rows}
            loading={statsQuery.isLoading || (openId !== null && employeesQuery.isLoading)}
            failed={statsQuery.isError}
            onRetry={() => statsQuery.refetch()}
            filters={filters}
            onFilters={setFilters}
            everyone={everyone}
            onOpen={canOpenEmployee ? openEmployee : undefined}
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
