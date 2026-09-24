import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Mail } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";

export default function SmtpTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData, isLoading: psLoading } = usePayrollSettings();

  const [payroll, setPayroll] = useState({
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUsername: "",
    smtpPassword: "",
    smtpFromEmail: "",
    smtpFromName: "UKTextiles HR",
  });

  useEffect(() => {
    if (!payrollSettingsData) return;
    setPayroll({
      smtpHost: payrollSettingsData.smtpHost || "smtp.gmail.com",
      smtpPort: payrollSettingsData.smtpPort || 587,
      smtpUsername: payrollSettingsData.smtpUsername || "",
      smtpPassword: payrollSettingsData.smtpPassword || "",
      smtpFromEmail: payrollSettingsData.smtpFromEmail || "",
      smtpFromName: payrollSettingsData.smtpFromName || "UKTextiles HR",
    });
  }, [payrollSettingsData]);

  const saveSmtp = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        smtpHost: payroll.smtpHost,
        smtpPort: payroll.smtpPort,
        smtpUsername: payroll.smtpUsername,
        smtpPassword: payroll.smtpPassword,
        smtpFromEmail: payroll.smtpFromEmail,
        smtpFromName: payroll.smtpFromName,
      } as never);
      toast({
        title: "SMTP settings saved",
        description: "Email sending will use these credentials from now on.",
      });
    } catch {
      toast({ title: "Failed to save SMTP settings", variant: "destructive" });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Mail size={15} className="text-blue-500" /> SMTP / Email Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-xs text-amber-700">
            For Gmail: use <strong>smtp.gmail.com</strong>, port <strong>587</strong>, and an{" "}
            <strong>App Password</strong> (not your Google account password). Enable 2FA on your Google account, then
            generate an App Password under Google Account → Security.
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {(
              [
                { label: "SMTP Host", key: "smtpHost", placeholder: "smtp.gmail.com" },
                { label: "SMTP Port", key: "smtpPort", placeholder: "587", isNum: true },
                { label: "Username (Gmail address)", key: "smtpUsername", placeholder: "hr@gmail.com" },
                { label: "App Password", key: "smtpPassword", type: "password", placeholder: "xxxx xxxx xxxx xxxx" },
                { label: "From Email", key: "smtpFromEmail", placeholder: "hr@uktextiles.in" },
                { label: "From Name", key: "smtpFromName", placeholder: "UKTextiles HR" },
              ] as { label: string; key: string; placeholder: string; type?: string; isNum?: boolean }[]
            ).map(({ label, key, type, placeholder, isNum }) => (
              <div key={key} className="space-y-1.5">
                <Label className="text-xs">{label}</Label>
                <Input
                  type={type ?? "text"}
                  value={String((payroll as any)[key] ?? "")}
                  onChange={(e) =>
                    setPayroll((p) => ({ ...p, [key]: isNum ? Number(e.target.value) : e.target.value }))
                  }
                  placeholder={placeholder}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <Button size="sm" onClick={() => saveSmtp()} disabled={updatePayrollSettings.isPending || psLoading}>
              {updatePayrollSettings.isPending ? "Saving…" : "Save SMTP Settings"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
