import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import NotFound from "@/pages/not-found";

import Landing from "@/pages/Landing";
import LoginSelect from "@/pages/LoginSelect";
import HrLogin from "@/pages/HrLogin";
import EmployeeLogin from "@/pages/EmployeeLogin";
import SetPassword from "@/pages/SetPassword";
import JobApply from "@/pages/JobApply";

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

import EmployeeDashboard from "@/pages/employee/Dashboard";
import EmployeeProfile from "@/pages/employee/Profile";
import EmployeeSalary from "@/pages/employee/Salary";
import EmployeeLeave from "@/pages/employee/Leave";
import EmployeeNotifications from "@/pages/employee/Notifications";

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
  allowedRoles: ("hr" | "employee")[];
}) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sidebar">
        <div className="text-white/60 text-sm">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    navigate("/login");
    return null;
  }

  if (!allowedRoles.includes(user.role)) {
    navigate(user.role === "hr" ? "/hr/dashboard" : "/employee/dashboard");
    return null;
  }

  return <Component />;
}

function Router() {
  return (
    <Switch>
      {/* Public */}
      <Route path="/" component={Landing} />
      <Route path="/login" component={LoginSelect} />
      <Route path="/hr-login" component={HrLogin} />
      <Route path="/employee-login" component={EmployeeLogin} />
      <Route path="/set-password" component={SetPassword} />
      <Route path="/apply/job/:id" component={JobApply} />

      {/* HR Routes */}
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
      <Route path="/hr/leave">
        {() => <ProtectedRoute component={Leave} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/salary">
        {() => <ProtectedRoute component={Salary} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/notifications">
        {() => <ProtectedRoute component={HrNotifications} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/interviews">
        {() => <ProtectedRoute component={Interviews} allowedRoles={["hr"]} />}
      </Route>
      <Route path="/hr/attendance">
        {() => <ProtectedRoute component={Attendance} allowedRoles={["hr"]} />}
      </Route>

      {/* Employee Routes */}
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
