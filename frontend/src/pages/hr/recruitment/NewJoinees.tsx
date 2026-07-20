import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  useListNewJoinees, useSendOfferLetterEmail,
  previewDocumentPdf, downloadDocumentPdf, type NewJoineeItem,
} from "@/lib/api-client/custom-hooks";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import { UserPlus, Eye, Download, Mail, Loader2 } from "lucide-react";

export default function NewJoinees() {
  const { toast } = useToast();
  const { token } = useAuth();
  const { data: joinees, isLoading } = useListNewJoinees(30);
  const sendEmail = useSendOfferLetterEmail();

  const [busy, setBusy] = useState<{ id: number; action: "preview" | "download" | "email" } | null>(null);

  const handlePreview = async (j: NewJoineeItem) => {
    setBusy({ id: j.id, action: "preview" });
    try {
      await previewDocumentPdf(`/api/employees/${j.id}/offer-letter/pdf`, () => token);
    } catch {
      toast({ title: "Failed to generate offer letter", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async (j: NewJoineeItem) => {
    setBusy({ id: j.id, action: "download" });
    try {
      await downloadDocumentPdf(`/api/employees/${j.id}/offer-letter/pdf`, () => token);
    } catch {
      toast({ title: "Failed to generate offer letter", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleEmail = async (j: NewJoineeItem) => {
    if (!j.email) {
      toast({ title: "No email on file", description: `${j.name} has no email address in their profile.`, variant: "destructive" });
      return;
    }
    setBusy({ id: j.id, action: "email" });
    try {
      const result = await sendEmail.mutateAsync({ employeeId: j.id });
      toast({ title: `Offer letter emailed to ${j.name}`, description: `Sent to ${result.sentTo} with the PDF attached.` });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Unknown error";
      toast({ title: "Failed to send offer letter", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
            <UserPlus size={22} className="text-emerald-600" />
            New Joinees
          </h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Employees who joined in the last 30 days — view, download, or email their Offer Letter.
          </p>
        </div>

        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
              </div>
            ) : !joinees || joinees.length === 0 ? (
              <div className="text-center py-16">
                <UserPlus size={36} className="mx-auto text-gray-200 mb-3" />
                <p className="text-muted-foreground text-sm">No new joinees in the last 30 days.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead>Designation</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Join Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {joinees.map(j => (
                    <TableRow key={j.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <EmployeeAvatar photoUrl={j.photoUrl} name={j.name} size={32} />
                          <div>
                            <p className="font-semibold text-sm text-gray-900">{j.name}</p>
                            <p className="text-xs text-gray-400">{j.employeeCode}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{j.department ?? "—"}</TableCell>
                      <TableCell className="text-sm">{j.designation ?? "—"}</TableCell>
                      <TableCell>
                        {j.branchName ? (
                          <Badge variant="outline" className="text-teal-700 border-teal-200 bg-teal-50">{j.branchName}</Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {j.joinDate ? new Date(j.joinDate).toLocaleDateString("en-IN") : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1.5">
                          <RowActionBtn
                            icon={busy?.id === j.id && busy.action === "preview" ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
                            label="View"
                            onClick={() => handlePreview(j)}
                            disabled={busy !== null}
                            color="gray"
                          />
                          <RowActionBtn
                            icon={busy?.id === j.id && busy.action === "download" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                            label="Download"
                            onClick={() => handleDownload(j)}
                            disabled={busy !== null}
                            color="green"
                          />
                          <RowActionBtn
                            icon={busy?.id === j.id && busy.action === "email" ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                            label="Email"
                            onClick={() => handleEmail(j)}
                            disabled={busy !== null}
                            color="purple"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {joinees && joinees.length > 0 && (
          <p className="text-xs text-gray-400">
            {joinees.length} new joinee{joinees.length !== 1 ? "s" : ""} in the last 30 days.
            Emailing automatically attaches the Offer Letter PDF.
          </p>
        )}
      </div>
    </HrLayout>
  );
}

function RowActionBtn({
  icon, label, onClick, disabled = false, color,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  color: "gray" | "green" | "purple";
}) {
  const colors = {
    gray:   "border-gray-200 text-gray-600 hover:bg-gray-50",
    green:  "border-green-200 text-green-700 hover:bg-green-50",
    purple: "border-purple-200 text-purple-700 hover:bg-purple-50",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded-lg transition-colors disabled:opacity-40 ${colors[color]}`}
    >
      {icon}
      {label}
    </button>
  );
}
