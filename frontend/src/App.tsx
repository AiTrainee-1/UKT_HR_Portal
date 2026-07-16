import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ConnectivityOverlay from "@/components/ConnectivityOverlay";
import { AuthProvider, useAuth, canView } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { toast } from "@/hooks/use-toast";
import { BiometricSyncProvider } from "@/contexts/BiometricSyncContext";
import GlobalSyncBanner from "@/components/GlobalSyncBanner";
import NotFound from "@/pages/not-found";

// Public pages
import Landing from "@/pages/Landing";
import LoginSelect from "@/pages/LoginSelect";
import HrLogin from "@/pages/HrLogin";
import EmployeeLogin from "@/pages/EmployeeLogin";
import ErpLogin from "@/pages/ErpLogin";
import SetPassword from "@/pages/SetPassword";
import JobApply from "@/pages/JobApply";
import DatabaseOffline from "@/pages/DatabaseOffline";

// HR pages
import HrDashboard from "@/pages/hr/Dashboard";
import Employees from "@/pages/hr/Employees";
import NewEmployee from "@/pages/hr/NewEmployee";
import EmployeeDetail from "@/pages/hr/EmployeeDetail";
import EditEmployee from "@/pages/hr/EditEmployee";
import Leave from "@/pages/hr/Leave";
import Salary from "@/pages/hr/Salary";
import HrNotifications from "@/pages/hr/Notifications";
import Interviews from "@/pages/hr/Interviews";
import RecruitmentDashboard from "@/pages/hr/recruitment/RecruitmentDashboard";
import Resignations from "@/pages/hr/recruitment/Resignations";
import RequiredRoles from "@/pages/hr/recruitment/RequiredRoles";
import Attendance from "@/pages/hr/Attendance";
import AttendanceReportLog from "@/pages/hr/AttendanceReportLog";
import Departments from "@/pages/hr/Departments";
import Designations from "@/pages/hr/Designations";
import Branches from "@/pages/hr/Branches";
import ManageShift from "@/pages/hr/ManageShift";
import LeaveHoliday from "@/pages/hr/LeaveHoliday";
import ApprovedRequests from "@/pages/hr/ApprovedRequests";
import PayrollFull from "@/pages/hr/PayrollFull";
import Settlement from "@/pages/hr/Settlement";
import Reports from "@/pages/hr/Reports";
import UserManagement from "@/pages/hr/UserManagement";
import AccountManagement from "@/pages/hr/AccountManagement";
import ActivityLogs from "@/pages/hr/ActivityLogs";
import Settings from "@/pages/hr/Settings";
import SalarySlip from "@/pages/hr/SalarySlip";
import Promotion from "@/pages/hr/Promotion";
import Increment from "@/pages/hr/Increment";
import Bonus from "@/pages/hr/Bonus";
import IdCards from "@/pages/hr/IdCards";
import CasualLeave from "@/pages/hr/CasualLeave";
import NightShift from "@/pages/hr/NightShift";
import HrChat from "@/pages/hr/Chat";
import VerifyEmployee from "@/pages/VerifyEmployee";

// Employee pages
import EmployeeDashboard from "@/pages/employee/Dashboard";
import EmployeeProfile from "@/pages/employee/Profile";
import EmployeeSalary from "@/pages/employee/Salary";
import EmployeeLeave from "@/pages/employee/Leave";
import EmployeeNotifications from "@/pages/employee/Notifications";

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
        // role's blocked write — see backend/api/permission_middleware.py,
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
        className="min-h-screen flex flex-col items-center justify-center gap-4"
        style={{ background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 50%, #eef4fc 100%)" }}
      >
        <svg viewBox="0 0 1536 1024" className="h-14 w-auto opacity-80" aria-hidden="true">
          <defs>
            <mask id="ukt-loading-ring-gap">
              <rect x="0" y="0" width="1536" height="1024" fill="white" />
              <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
            </mask>
          </defs>
          <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ukt-loading-ring-gap)" />
          <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
          <path fill="#FFFFFF" d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z" />
        </svg>
        <div className="flex items-center gap-2" style={{ color: "rgba(0,100,150,0.5)" }}>
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8z"/>
          </svg>
          <span className="text-sm font-semibold" style={{ fontFamily: "'Hanken Grotesk', Inter, sans-serif" }}>Loading…</span>
        </div>
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

  // Defense in depth — the API is the authoritative 403 for a hidden module,
  // this just avoids flashing a broken page if a restricted user hits the
  // URL directly (e.g. from a stale bookmark after their access changed).
  const moduleKey = moduleForPath(location);
  if (moduleKey && !canView(user, moduleKey)) {
    navigate("/hr/dashboard");
    return null;
  }

  return <Component />;
}

function Router() {
  return (
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

      {/* ── HR Routes ─────────────────────────────────────────── */}
      <Route path="/hr/dashboard">
        {() => <ProtectedRoute component={HrDashboard} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/employees/new">
        {() => <ProtectedRoute component={NewEmployee} allowedRoles={["hr"]} />}
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
      <Route path="/hr/night-shift">
        {() => <ProtectedRoute component={NightShift} allowedRoles={["hr"]} />}
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
        {() => <ProtectedRoute component={PayrollFull} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/salary">
        {() => <ProtectedRoute component={Salary} allowedRoles={["hr"]} />}
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
      <Route path="/hr/account-management">
        {() => <ProtectedRoute component={AccountManagement} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/activity-logs">
        {() => <ProtectedRoute component={ActivityLogs} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/settings">
        {() => <ProtectedRoute component={Settings} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/salary-slip">
        {() => <ProtectedRoute component={SalarySlip} allowedRoles={["hr"]} />}
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
      <Route path="/hr/recruitment/resignations">
        {() => <ProtectedRoute component={Resignations} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/recruitment/required-roles">
        {() => <ProtectedRoute component={RequiredRoles} allowedRoles={["hr"]} />}
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
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <BiometricSyncProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
            <GlobalSyncBanner />
          </BiometricSyncProvider>
        </AuthProvider>
        <Toaster />
        <ConnectivityOverlay />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
