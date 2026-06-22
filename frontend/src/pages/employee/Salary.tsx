import EmployeeLayout from "@/components/EmployeeLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import Loader from "@/components/Loader";
import { useAuth } from "@/contexts/AuthContext";
import { useListSalaryRecords } from "@/lib/api-client";
import { IndianRupee } from "lucide-react";

export default function EmployeeSalary() {
  const { user } = useAuth();
  const empId = user?.employeeId;

  const { data: records, isLoading } = useListSalaryRecords(
    empId ? { employeeId: empId } : {}
  );


  return (
    <EmployeeLayout>
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-2xl font-black">My Salary</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Your payment history</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center min-h-[300px]">
            <Loader />
          </div>
        ) : records && records.length > 0 ? (
          <div className="relative pl-6">
            {/* Timeline line */}
            <div className="absolute left-2 top-0 bottom-0 w-0.5 bg-border" />
            <div className="space-y-4">
              {records.map((rec) => (
                <div key={rec.id} className="relative" data-testid={`salary-record-${rec.id}`}>
                  {/* Timeline dot */}
                  <div className={`absolute -left-4 top-5 w-3 h-3 rounded-full border-2 border-background ${rec.status === "paid" ? "bg-green-500" : "bg-amber-500"}`} />
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                            <IndianRupee size={16} className="text-muted-foreground" />
                          </div>
                          <div>
                            <p className="font-bold text-sm">
                              {new Date(rec.year, rec.month - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
                            </p>
                            <p className="text-xs text-muted-foreground capitalize mt-0.5">{rec.type} salary</p>
                            {rec.notes && <p className="text-xs text-muted-foreground mt-1 italic">{rec.notes}</p>}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="font-black text-lg">₹{Number(rec.amount).toLocaleString("en-IN")}</p>
                          <Badge className={rec.status === "paid" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
                            {rec.status}
                          </Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <IndianRupee size={32} className="mb-3 opacity-30" />
              <p className="font-medium">No salary records yet</p>
            </CardContent>
          </Card>
        )}
      </div>
    </EmployeeLayout>
  );
}
