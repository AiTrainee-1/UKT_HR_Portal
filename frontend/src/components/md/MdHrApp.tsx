import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { canViewRoute, useAuth } from "@/contexts/AuthContext";
import { setViewOnlyWorkflows } from "@/lib/approval-workflow";
import { hrToMd, MdEmbedProvider, useMdHrLocation } from "@/lib/md/embed";
import { viewOnlyWorkflowsFor } from "@/lib/md/view-only-requests";
import { moduleForPath } from "@/lib/permission-modules";
import NotFound from "@/pages/not-found";

// The Managing Director's copies of the HR pages: the HR portal's own page components, mounted here under /md/... with the
// MD shell around them (lib/md/embed.ts explains how). Same features, same buttons, same API; the MD's access to the
// modules behind them is backend/api/permission_registry.py::MD_HR_GRANTS, and it reaches the page through /auth/me, so the
// pages' own permission checks work unchanged.
//
// One entry per HR page (and sub-page) that the MD portal serves; keep it in step with EMBEDDED_HR_PREFIXES in lib/md/embed.ts.

// The MD has a dashboard of its own (not the HR dashboard with the MD's extras): pages/md/home
const Dashboard = lazy(() => import("@/pages/md/home"));
const Employees = lazy(() => import("@/pages/hr/Employees"));
const NewEmployee = lazy(() => import("@/pages/hr/NewEmployee"));
const BulkUploadEmployees = lazy(() => import("@/pages/hr/BulkUploadEmployees"));
const EmployeeDetail = lazy(() => import("@/pages/hr/EmployeeDetail"));
const EditEmployee = lazy(() => import("@/pages/hr/EditEmployee"));
const Branches = lazy(() => import("@/pages/hr/Branches"));
const Attendance = lazy(() => import("@/pages/hr/Attendance"));
const AttendancePunchSearch = lazy(() => import("@/pages/hr/AttendancePunchSearch"));
const AttendanceReportLog = lazy(() => import("@/pages/hr/AttendanceReportLog"));
const PunchView = lazy(() => import("@/pages/hr/PunchView"));
const BiometricDeviceStatus = lazy(() => import("@/pages/hr/BiometricDeviceStatus"));
const GeoAttendance = lazy(() => import("@/pages/hr/GeoAttendance"));
const OutpassVisitors = lazy(() => import("@/pages/hr/OutpassVisitors"));
const ManageShift = lazy(() => import("@/pages/hr/ManageShift"));
const LeaveHoliday = lazy(() => import("@/pages/hr/LeaveHoliday"));
const ApprovedRequests = lazy(() => import("@/pages/hr/ApprovedRequests"));

/** A page the MD may open: the same reachability rule the HR portal applies (the MD's effective permissions), and back to
 *  the MD dashboard when it does not hold (a role-less MD whose grants were trimmed, say). */
function Page({ component: Component }: { component: ComponentType }) {
  const { user } = useAuth();
  const [location] = useLocation();
  // The requests the MD only views (leave, permission, outpass): the pages draw Approve / Reject only when this allows it.
  // Set here, before the page renders, because a page builds its buttons in its own render, ahead of the layout around it.
  setViewOnlyWorkflows(viewOnlyWorkflowsFor(user));
  if (!canViewRoute(user, location, moduleForPath(location))) return <Redirect to="~/md/dashboard" replace />;
  return <Component />;
}

const page = (Component: ComponentType) => () => <Page component={Component} />;

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <CircleLoader logo texts={["UK Textiles", "MD Portal", "Loading"]} />
    </div>
  );
}

export default function MdHrApp() {
  // leaving the MD portal (to the HR portal, or signing out) gives every page its decision buttons back
  useEffect(() => () => setViewOnlyWorkflows(null), []);
  return (
    <MdEmbedProvider value={true}>
      <WouterRouter hook={useMdHrLocation} hrefs={hrToMd}>
        <Suspense fallback={<Loading />}>
          <Switch>
            <Route path="/hr/dashboard">{page(Dashboard)}</Route>

            <Route path="/hr/employees/new">{page(NewEmployee)}</Route>
            <Route path="/hr/employees/bulk-upload">{page(BulkUploadEmployees)}</Route>
            <Route path="/hr/employees/:id/edit">{page(EditEmployee)}</Route>
            <Route path="/hr/employees/:id">{page(EmployeeDetail)}</Route>
            <Route path="/hr/employees">{page(Employees)}</Route>
            <Route path="/hr/branches">{page(Branches)}</Route>

            <Route path="/hr/attendance/staff">{page(Attendance)}</Route>
            <Route path="/hr/attendance/production">{page(Attendance)}</Route>
            <Route path="/hr/attendance/search">{page(AttendancePunchSearch)}</Route>
            <Route path="/hr/attendance/report-log">{page(AttendanceReportLog)}</Route>
            <Route path="/hr/attendance/punch-view">{page(PunchView)}</Route>
            <Route path="/hr/attendance">{() => <Redirect to="/hr/attendance/staff" replace />}</Route>
            <Route path="/hr/Biometric-Connectors/device-status">{page(BiometricDeviceStatus)}</Route>
            <Route path="/hr/geo-attendance">{page(GeoAttendance)}</Route>

            <Route path="/hr/outpass-visitors/outpass">{page(OutpassVisitors)}</Route>
            <Route path="/hr/outpass-visitors/visitors">{page(OutpassVisitors)}</Route>
            <Route path="/hr/outpass-visitors/tea-break">{page(OutpassVisitors)}</Route>
            <Route path="/hr/outpass-visitors">{() => <Redirect to="/hr/outpass-visitors/outpass" replace />}</Route>

            <Route path="/hr/shifts">{page(ManageShift)}</Route>
            <Route path="/hr/leave">{page(LeaveHoliday)}</Route>
            <Route path="/hr/requests">{page(ApprovedRequests)}</Route>

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </WouterRouter>
    </MdEmbedProvider>
  );
}
