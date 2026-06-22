import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Printer, IdCard } from "lucide-react";

interface IdCardProps {
  employee: {
    firstName: string;
    lastName: string;
    employeeCode: string;
    departmentName?: string;
    email?: string;
    phone?: string;
    joinDate?: string;
    status?: string;
    bloodGroup?: string;
    emergencyContact?: string;
  };
  companyName?: string;
}

export function EmployeeIdCard({ employee, companyName = "UK TEXTILES" }: IdCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const initials = `${employee.firstName[0]}${employee.lastName[0]}`.toUpperCase();

  const handlePrint = () => {
    const card = cardRef.current;
    if (!card) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Employee ID - ${employee.firstName} ${employee.lastName}</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap');
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { background: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: 'Inter', sans-serif; }
            @media print {
              body { margin: 0; }
              @page { size: 85.6mm 54mm; margin: 0; }
            }
          </style>
        </head>
        <body>${card.innerHTML}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); printWindow.close(); }, 500);
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <IdCard size={15} />
          View ID Card
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Employee ID Card</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {/* Card */}
          <div ref={cardRef}>
            <div style={{
              width: "340px",
              height: "214px",
              borderRadius: "12px",
              overflow: "hidden",
              fontFamily: "Inter, sans-serif",
              position: "relative",
              border: "1px solid #e2e8f0",
              background: "white",
              display: "flex",
              flexDirection: "column",
            }}>
              {/* Header strip */}
              <div style={{
                background: "linear-gradient(135deg, #1e293b 0%, #334155 100%)",
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}>
                <div>
                  <div style={{ color: "white", fontWeight: 700, fontSize: "13px", letterSpacing: "0.02em" }}>
                    {companyName.toUpperCase()}
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: "9px", letterSpacing: "0.08em", textTransform: "uppercase", marginTop: "1px" }}>
                    Employee Identity Card
                  </div>
                </div>
                <div style={{
                  width: "8px", height: "28px", borderRadius: "2px",
                  background: "linear-gradient(180deg, #3b82f6, #8b5cf6)"
                }} />
              </div>

              {/* Body */}
              <div style={{ display: "flex", flex: 1, padding: "14px 16px", gap: "14px" }}>
                {/* Avatar */}
                <div style={{ flexShrink: 0 }}>
                  <div style={{
                    width: "64px", height: "64px", borderRadius: "8px",
                    background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "white", fontWeight: 700, fontSize: "22px",
                  }}>
                    {initials}
                  </div>
                  <div style={{
                    marginTop: "6px",
                    background: "#f1f5f9",
                    borderRadius: "4px",
                    padding: "3px 6px",
                    textAlign: "center",
                    fontSize: "9px",
                    fontWeight: 600,
                    color: "#475569",
                    letterSpacing: "0.04em",
                  }}>
                    {employee.status?.toUpperCase() ?? "ACTIVE"}
                  </div>
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: "16px", color: "#0f172a", lineHeight: 1.2 }}>
                    {employee.firstName} {employee.lastName}
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: "3px" }}>
                    {employee.departmentName ?? "—"}
                  </div>

                  <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "4px" }}>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <span style={{ fontSize: "9px", color: "#94a3b8", width: "28px", flexShrink: 0 }}>ID</span>
                      <span style={{ fontSize: "10px", fontWeight: 600, color: "#1e293b", fontFamily: "monospace" }}>
                        {employee.employeeCode}
                      </span>
                    </div>
                    {employee.phone && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <span style={{ fontSize: "9px", color: "#94a3b8", width: "28px", flexShrink: 0 }}>PH</span>
                        <span style={{ fontSize: "10px", color: "#334155" }}>{employee.phone}</span>
                      </div>
                    )}
                    {employee.email && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <span style={{ fontSize: "9px", color: "#94a3b8", width: "28px", flexShrink: 0 }}>EM</span>
                        <span style={{ fontSize: "10px", color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {employee.email}
                        </span>
                      </div>
                    )}
                    {employee.bloodGroup && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <span style={{ fontSize: "9px", color: "#94a3b8", width: "28px", flexShrink: 0 }}>BG</span>
                        <span style={{ fontSize: "10px", fontWeight: 600, color: "#dc2626" }}>{employee.bloodGroup}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div style={{
                background: "#f8fafc",
                borderTop: "1px solid #e2e8f0",
                padding: "6px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}>
                <div style={{ fontSize: "8px", color: "#94a3b8" }}>
                  {employee.joinDate
                    ? `Joined: ${new Date(employee.joinDate).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`
                    : ""}
                </div>
                {/* Barcode-style decoration */}
                <div style={{ display: "flex", gap: "1.5px", alignItems: "flex-end", height: "18px" }}>
                  {[3,5,4,7,3,5,6,4,5,7,3,4,6,5,4,3,6,5].map((h, i) => (
                    <div key={i} style={{
                      width: "1.5px",
                      height: `${h * 2.2}px`,
                      background: "#334155",
                      borderRadius: "1px",
                    }} />
                  ))}
                </div>
                <div style={{ fontSize: "8px", color: "#94a3b8" }}>
                  {employee.emergencyContact ? `Emg: ${employee.emergencyContact}` : companyName}
                </div>
              </div>
            </div>
          </div>

          <Button onClick={handlePrint} className="gap-2 w-full max-w-[340px]">
            <Printer size={15} />
            Print ID Card
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}