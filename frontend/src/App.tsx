import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
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
import Attendance from "@/pages/hr/Attendance";
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
import ActivityLogs from "@/pages/hr/ActivityLogs";
import Settings from "@/pages/hr/Settings";
import SalarySlip from "@/pages/hr/SalarySlip";

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
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="text-white/60 text-sm">Loading…</div>
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
      <Route path="/hr/attendance">
        {() => <ProtectedRoute component={Attendance} allowedRoles={["hr"]} />}
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
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
