import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ConnectivityOverlay from "@/components/ConnectivityOverlay";
import { AuthProvider, useAuth, canViewRoute } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { toast } from "@/hooks/use-toast";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { BiometricSyncProvider } from "@/contexts/BiometricSyncContext";
import GlobalSyncBanner from "@/components/GlobalSyncBanner";
import { PayrollGenerationProvider } from "@/contexts/PayrollGenerationContext";
import GlobalPayrollBanner from "@/components/GlobalPayrollBanner";
import { SalarySlipBulkProvider } from "@/contexts/SalarySlipBulkContext";
import GlobalSalarySlipBulkBanner from "@/components/GlobalSalarySlipBulkBanner";
import { WhatsAppBulkProvider } from "@/contexts/WhatsAppBulkContext";
import GlobalWhatsAppBulkBanner from "@/components/GlobalWhatsAppBulkBanner";
import { ResumeScreeningProvider } from "@/contexts/ResumeScreeningContext";
import GlobalResumeScreeningBanner from "@/components/GlobalResumeScreeningBanner";
import { CircleLoader } from "@/components/ui/CircleLoader";
import NotFound from "@/pages/not-found";

// Public pages
import Landing from "@/pages/Landing";
import LoginSelect from "@/pages/LoginSelect";
import HrLogin from "@/pages/HrLogin";
import EmployeeLogin from "@/pages/EmployeeLogin";
const ErpLogin = lazy(() => import("@/pages/ErpLogin"));
const SetPassword = lazy(() => import("@/pages/SetPassword"));
const JobApply = lazy(() => import("@/pages/JobApply"));
const DatabaseOffline = lazy(() => import("@/pages/DatabaseOffline"));
const OutpassGate = lazy(() => import("@/pages/gate/OutpassGate"));
const VisitorGate = lazy(() => import("@/pages/gate/VisitorGate"));
const GateScannerLogin = lazy(() => import("@/pages/gate/GateScannerLogin"));
const ReceptionLogin = lazy(() => import("@/pages/gate/ReceptionLogin"));
const ReceptionConsole = lazy(() => import("@/pages/gate/ReceptionConsole"));
const GateScannerConsole = lazy(() => import("@/pages/gate/GateScannerConsole"));

// HR pages
const HrDashboard = lazy(() => import("@/pages/hr/Dashboard"));
const Employees = lazy(() => import("@/pages/hr/Employees"));
const NewEmployee = lazy(() => import("@/pages/hr/NewEmployee"));
const BulkUploadEmployees = lazy(() => import("@/pages/hr/BulkUploadEmployees"));
const ManualPunchImport = lazy(() => import("@/pages/hr/ManualPunchImport"));
const PunchView = lazy(() => import("@/pages/hr/PunchView"));
const EmployeeDetail = lazy(() => import("@/pages/hr/EmployeeDetail"));
const EditEmployee = lazy(() => import("@/pages/hr/EditEmployee"));
const Leave = lazy(() => import("@/pages/hr/Leave"));
const StaffPayroll = lazy(() => import("@/pages/hr/StaffPayroll"));
const HrNotifications = lazy(() => import("@/pages/hr/Notifications"));
const Interviews = lazy(() => import("@/pages/hr/Interviews"));
const RecruitmentDashboard = lazy(() => import("@/pages/hr/recruitment/RecruitmentDashboard"));
const NewJoinees = lazy(() => import("@/pages/hr/recruitment/NewJoinees"));
const Resignations = lazy(() => import("@/pages/hr/recruitment/Resignations"));
const RequiredRoles = lazy(() => import("@/pages/hr/recruitment/RequiredRoles"));
const ResumeScreening = lazy(() => import("@/pages/hr/recruitment/ResumeScreening"));
const Documents = lazy(() => import("@/pages/hr/recruitment/Documents"));
const Attendance = lazy(() => import("@/pages/hr/Attendance"));
const AttendanceReportLog = lazy(() => import("@/pages/hr/AttendanceReportLog"));
const OutpassVisitors = lazy(() => import("@/pages/hr/OutpassVisitors"));
const Departments = lazy(() => import("@/pages/hr/Departments"));
const Designations = lazy(() => import("@/pages/hr/Designations"));
const Branches = lazy(() => import("@/pages/hr/Branches"));
const ManageShift = lazy(() => import("@/pages/hr/ManageShift"));
const LeaveHoliday = lazy(() => import("@/pages/hr/LeaveHoliday"));
const ApprovedRequests = lazy(() => import("@/pages/hr/ApprovedRequests"));
const ProductionPayroll = lazy(() => import("@/pages/hr/ProductionPayroll"));
const Settlement = lazy(() => import("@/pages/hr/Settlement"));
const Compensation = lazy(() => import("@/pages/hr/Compensation"));
const Reports = lazy(() => import("@/pages/hr/Reports"));
const UserManagement = lazy(() => import("@/pages/hr/UserManagement"));
const ManagerDetail = lazy(() => import("@/pages/hr/ManagerDetail"));
const AccountManagement = lazy(() => import("@/pages/hr/AccountManagement"));
const AccountManagementMaster = lazy(() => import("@/pages/hr/AccountManagementMaster"));
const ActivityLogs = lazy(() => import("@/pages/hr/ActivityLogs"));
const LoginDevices = lazy(() => import("@/pages/hr/LoginDevices"));
const MobileAppLogin = lazy(() => import("@/pages/hr/MobileAppLogin"));
const WhatsAppControl = lazy(() => import("@/pages/hr/WhatsAppControl"));
const Settings = lazy(() => import("@/pages/hr/Settings"));
const Promotion = lazy(() => import("@/pages/hr/Promotion"));
const Increment = lazy(() => import("@/pages/hr/Increment"));
const Bonus = lazy(() => import("@/pages/hr/Bonus"));
const IdCards = lazy(() => import("@/pages/hr/IdCards"));
const CasualLeave = lazy(() => import("@/pages/hr/CasualLeave"));
const MissingPunch = lazy(() => import("@/pages/hr/MissingPunch"));
const GeoAttendance = lazy(() => import("@/pages/hr/GeoAttendance"));
const AttendancePunchSearch = lazy(() => import("@/pages/hr/AttendancePunchSearch"));
const HrChat = lazy(() => import("@/pages/hr/Chat"));
const VerifyEmployee = lazy(() => import("@/pages/VerifyEmployee"));

// Employee pages
const EmployeeDashboard = lazy(() => import("@/pages/employee/Dashboard"));
const EmployeeProfile = lazy(() => import("@/pages/employee/Profile"));
const EmployeeSalary = lazy(() => import("@/pages/employee/Salary"));
const EmployeeLeave = lazy(() => import("@/pages/employee/Leave"));
const EmployeeNotifications = lazy(() => import("@/pages/employee/Notifications"));

// ERP pages
import {
  ErpDashboard, ProductionPlanning, Merchandising, PurchaseManagement,
  InventoryManagement, FabricManagement, AccessoriesManagement,
  OrderManagement, Sampling, QualityControl, Cutting, Sewing,
  Finishing, Packing, ShipmentManagement, VendorManagement,
  CustomerManagement, Finance, ErpReports, ErpSettings,
} from "@/pages/erp/ErpPlaceholder";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
    mutations: {
      onError: (error) => {
        // Centralized so pages don't each need to special-case a view-only
        // role's blocked write -see backend/api/permission_middleware.py,
        // which is the actual enforcer this is just explaining.
        if (error instanceof ApiError && error.status === 403 && (error.data as any)?.error === "permission_denied") {
          toast({
            title: "View-only access",
            description: "You have view-only access to this section.",
            variant: "destructive",
          });
        }
      },
    },
  },
});

function ProtectedRoute({
  component: Component,
  allowedRoles,
}: {
  component: React.ComponentType;
  allowedRoles: ("hr" | "employee" | "erp")[];
}) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const [location, navigate] = useLocation();

  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 50%, #eef4fc 100%)" }}
      >
        {/* The boot screen -what a full reload (F5) shows while the session
            is being restored. Same loader as the rest of the portal, with
            the mark, so a hard refresh looks like the app starting rather
            than like a different product. */}
        <CircleLoader
          logo
          texts={["UK Textiles", "HR Portal", "Loading"]}
        />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    navigate("/");
    return null;
  }

  if (!allowedRoles.includes(user.role as any)) {
    navigate(user.role === "hr" ? "/hr/dashboard" : "/employee/dashboard");
    return null;
  }

  // Account Management is admin-only, independent of Role.permissions.
  if (location.startsWith("/hr/account-management") && !user.isSuperAdmin) {
    navigate("/hr/dashboard");
    return null;
  }

  // Activity Logs is the company-wide audit trail -admin-only, like
  // Account Management, and independent of Role.permissions. Branch users
  // do not review their own audit trail; that is an oversight tool.
  if (location.startsWith("/hr/activity-logs") && !user.isSuperAdmin) {
    navigate("/hr/dashboard");
    return null;
  }

  // ...and its Master page is narrower still: the single ADMIN_USERNAME
  // account, not every super admin. Hiding an account would be pointless if
  // any other admin could come here and unhide it. The API enforces the same
  // rule (auth.require_master_admin) -this only avoids a dead page.
  if (location.startsWith("/hr/account-management/master") && !user.isMasterAdmin) {
    navigate("/hr/account-management");
    return null;
  }

  // Defense in depth -the API is the authoritative 403 for a hidden module,
  // this just avoids flashing a broken page if a restricted user hits the
  // URL directly (e.g. from a stale bookmark after their access changed).
  const moduleKey = moduleForPath(location);
  if (!canViewRoute(user, location, moduleKey)) {
    navigate("/hr/dashboard");
    return null;
  }

  return <Component />;
}

// Every page except the entry/login screens is its own chunk, so the first
// paint no longer downloads all ~70 pages (Settings alone is ~4k lines).
function PageLoader() {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 50%, #eef4fc 100%)" }}
    >
      <CircleLoader logo texts={["UK Textiles", "HR Portal", "Loading"]} />
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
    <Switch>
      {/* ── Public ────────────────────────────────────────────── */}
      <Route path="/" component={Landing} />
      <Route path="/login" component={LoginSelect} />
      <Route path="/hr-login" component={HrLogin} />
      <Route path="/employee-login" component={EmployeeLogin} />
      <Route path="/erp-login" component={ErpLogin} />
      <Route path="/set-password" component={SetPassword} />
      <Route path="/apply/job/:id" component={JobApply} />
      <Route path="/verify/:code" component={VerifyEmployee} />
      <Route path="/db-offline" component={DatabaseOffline} />
      <Route path="/gate/outpass/:token" component={OutpassGate} />
      <Route path="/gate/visitor/:token" component={VisitorGate} />
      {/* Gate Scanner kiosk -literal /console route must be registered
          before the :loginToken param route, or "console" would itself be
          matched as a login token. */}
      <Route path="/gate-scanner/console" component={GateScannerConsole} />
      <Route path="/gate-scanner/:loginToken" component={GateScannerLogin} />
      {/* Reception desk -same literal-before-param ordering as Gate Scanner above. */}
      <Route path="/reception/console" component={ReceptionConsole} />
      <Route path="/reception-login/:loginToken" component={ReceptionLogin} />

      {/* ── HR Routes ─────────────────────────────────────────── */}
      <Route path="/hr/dashboard">
        {() => <ProtectedRoute component={HrDashboard} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/employees/new">
        {() => <ProtectedRoute component={NewEmployee} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/employees/bulk-upload">
        {() => <ProtectedRoute component={BulkUploadEmployees} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/employees/:id/edit">
        {() => <ProtectedRoute component={EditEmployee} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/employees/:id">
        {() => <ProtectedRoute component={EmployeeDetail} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/employees">
        {() => <ProtectedRoute component={Employees} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/departments">
        {() => <ProtectedRoute component={Departments} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/designations">
        {() => <ProtectedRoute component={Designations} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/branches">
        {() => <ProtectedRoute component={Branches} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance/report-log">
        {() => <ProtectedRoute component={AttendanceReportLog} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/outpass-visitors/outpass">
        {() => <ProtectedRoute component={OutpassVisitors} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/outpass-visitors/visitors">
        {() => <ProtectedRoute component={OutpassVisitors} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/outpass-visitors/tea-break">
        {() => <ProtectedRoute component={OutpassVisitors} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/outpass-visitors">
        {() => <ProtectedRoute component={OutpassVisitors} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance/search">
        {() => <ProtectedRoute component={AttendancePunchSearch} allowedRoles={["hr"]} />}
      </Route>
      {/* Route kept so the old page is reachable if inbound device access is
          ever set up -its header button is hidden, not removed. */}
      <Route path="/hr/attendance/manual-import">
        {() => <ProtectedRoute component={ManualPunchImport} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance/punch-view">
        {() => <ProtectedRoute component={PunchView} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance/staff">
        {() => <ProtectedRoute component={Attendance} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance/production">
        {() => <ProtectedRoute component={Attendance} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance">
        {() => <ProtectedRoute component={Attendance} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/promotion">
        {() => <ProtectedRoute component={Promotion} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/increment">
        {() => <ProtectedRoute component={Increment} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/bonus">
        {() => <ProtectedRoute component={Bonus} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/id-cards">
        {() => <ProtectedRoute component={IdCards} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/casual-leave">
        {() => <ProtectedRoute component={CasualLeave} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/missing-punch">
        {() => <ProtectedRoute component={MissingPunch} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/geo-attendance">
        {() => <ProtectedRoute component={GeoAttendance} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/chat">
        {() => <ProtectedRoute component={HrChat} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/shifts">
        {() => <ProtectedRoute component={ManageShift} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/leave">
        {() => <ProtectedRoute component={LeaveHoliday} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/requests">
        {() => <ProtectedRoute component={ApprovedRequests} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/payroll">
        {() => <ProtectedRoute component={StaffPayroll} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/production-payroll">
        {() => <ProtectedRoute component={ProductionPayroll} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/salary">
        {() => <Redirect to="/hr/payroll" />}
      </Route>
      <Route path="/hr/compensation">
        {() => <ProtectedRoute component={Compensation} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/settlement">
        {() => <ProtectedRoute component={Settlement} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/reports">
        {() => <ProtectedRoute component={Reports} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/user-management">
        {() => <ProtectedRoute component={UserManagement} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/user-management/:id">
        {() => <ProtectedRoute component={ManagerDetail} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/account-management/master">
        {() => <ProtectedRoute component={AccountManagementMaster} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/account-management">
        {() => <ProtectedRoute component={AccountManagement} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/activity-logs">
        {() => <ProtectedRoute component={ActivityLogs} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/login-devices">
        {() => <ProtectedRoute component={LoginDevices} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/mobile-app-login">
        {() => <ProtectedRoute component={MobileAppLogin} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/whatsapp-control">
        {() => <ProtectedRoute component={WhatsAppControl} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/settings">
        {() => <ProtectedRoute component={Settings} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/salary-slip">
        {() => <Redirect to="/hr/payroll" />}
      </Route>
      <Route path="/hr/notifications">
        {() => <ProtectedRoute component={HrNotifications} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/interviews">
        {() => <ProtectedRoute component={Interviews} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/dashboard">
        {() => <ProtectedRoute component={RecruitmentDashboard} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/new-joinees">
        {() => <ProtectedRoute component={NewJoinees} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/resignations">
        {() => <ProtectedRoute component={Resignations} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/required-roles">
        {() => <ProtectedRoute component={RequiredRoles} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/resume-screening">
        {() => <ProtectedRoute component={ResumeScreening} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/documents">
        {() => <ProtectedRoute component={Documents} allowedRoles={["hr"]} />}
      </Route>

      {/* ── Employee Routes ───────────────────────────────────── */}
      <Route path="/employee/dashboard">
        {() => <ProtectedRoute component={EmployeeDashboard} allowedRoles={["employee"]} />}
      </Route>
      <Route path="/employee/profile">
        {() => <ProtectedRoute component={EmployeeProfile} allowedRoles={["employee"]} />}
      </Route>
      <Route path="/employee/salary">
        {() => <ProtectedRoute component={EmployeeSalary} allowedRoles={["employee"]} />}
      </Route>
      <Route path="/employee/leave">
        {() => <ProtectedRoute component={EmployeeLeave} allowedRoles={["employee"]} />}
      </Route>
      <Route path="/employee/notifications">
        {() => <ProtectedRoute component={EmployeeNotifications} allowedRoles={["employee"]} />}
      </Route>

      {/* ── ERP Routes ────────────────────────────────────────── */}
      <Route path="/erp/dashboard" component={ErpDashboard} />
      <Route path="/erp/production" component={ProductionPlanning} />
      <Route path="/erp/merchandising" component={Merchandising} />
      <Route path="/erp/purchase" component={PurchaseManagement} />
      <Route path="/erp/inventory" component={InventoryManagement} />
      <Route path="/erp/fabric" component={FabricManagement} />
      <Route path="/erp/accessories" component={AccessoriesManagement} />
      <Route path="/erp/orders" component={OrderManagement} />
      <Route path="/erp/sampling" component={Sampling} />
      <Route path="/erp/quality" component={QualityControl} />
      <Route path="/erp/cutting" component={Cutting} />
      <Route path="/erp/sewing" component={Sewing} />
      <Route path="/erp/finishing" component={Finishing} />
      <Route path="/erp/packing" component={Packing} />
      <Route path="/erp/shipment" component={ShipmentManagement} />
      <Route path="/erp/vendors" component={VendorManagement} />
      <Route path="/erp/customers" component={CustomerManagement} />
      <Route path="/erp/finance" component={Finance} />
      <Route path="/erp/reports" component={ErpReports} />
      <Route path="/erp/settings" component={ErpSettings} />

      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          {/* Inside AuthProvider so its /api/theme-settings fetch is
              authenticated; the cached theme still paints immediately. */}
          <ThemeProvider>
          <BiometricSyncProvider>
            <PayrollGenerationProvider>
              <SalarySlipBulkProvider>
                <WhatsAppBulkProvider>
                  <ResumeScreeningProvider>
                    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                      <Router />
                    </WouterRouter>
                    <GlobalSyncBanner />
                    <GlobalPayrollBanner />
                    <GlobalSalarySlipBulkBanner />
                    <GlobalWhatsAppBulkBanner />
                    <GlobalResumeScreeningBanner />
                  </ResumeScreeningProvider>
                </WhatsAppBulkProvider>
              </SalarySlipBulkProvider>
            </PayrollGenerationProvider>
          </BiometricSyncProvider>
          </ThemeProvider>
        </AuthProvider>
        <Toaster />
        <ConnectivityOverlay />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
