import HrLayout from "@/components/HrLayout";
import FactoryEmployeesPage from "./factory-employees/FactoryEmployeesPage";

// Employees -> Factory Employees (/hr/employees/factory-emp): drivers, housekeeping, chefs, security and other factory
// support staff, organised by label. The page lives in ./factory-employees.
export default function FactoryEmployees() {
  return (
    <HrLayout>
      <FactoryEmployeesPage />
    </HrLayout>
  );
}
