import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { FileText, Upload, X } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";
import { compressImageToDataUrl } from "@/lib/image-compression";

// Logo/signature uploads are compressed with compressImageToDataUrl before they become the base64
// data URI sent in the JSON PUT (see config/settings.py DATA_UPLOAD_MAX_MEMORY_SIZE).

export default function SalarySlipTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData } = usePayrollSettings();

  const [payroll, setPayroll] = useState({
    slipCompanyName: "UK TEXTILES - H.O",
    slipCompanyAddress: "TIRUPUR",
    minWageRate: 0,
    signatureImage: null as string | null,
    companyLogo: null as string | null,
    authorizedSignature: null as string | null,
  });

  useEffect(() => {
    if (!payrollSettingsData) return;
    setPayroll({
      slipCompanyName: payrollSettingsData.slipCompanyName || "UK TEXTILES - H.O",
      slipCompanyAddress: payrollSettingsData.slipCompanyAddress || "TIRUPUR",
      minWageRate: payrollSettingsData.minWageRate || 0,
      signatureImage: payrollSettingsData.signatureImage || null,
      companyLogo: payrollSettingsData.companyLogo || null,
      authorizedSignature: payrollSettingsData.authorizedSignature || null,
    });
  }, [payrollSettingsData]);

  const saveSalarySlip = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        slipCompanyName: payroll.slipCompanyName,
        slipCompanyAddress: payroll.slipCompanyAddress,
        minWageRate: payroll.minWageRate,
        signatureImage: payroll.signatureImage ?? undefined,
        companyLogo: payroll.companyLogo ?? undefined,
        authorizedSignature: payroll.authorizedSignature ?? undefined,
      } as never);
      toast({ title: "Salary Slip settings saved" });
    } catch {
      toast({ title: "Failed to save Salary Slip settings", variant: "destructive" });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <FileText size={15} className="text-blue-500" /> Salary Slip Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Company Name (on slip header)</Label>
              <Input
                value={payroll.slipCompanyName}
                onChange={(e) => setPayroll((p) => ({ ...p, slipCompanyName: e.target.value }))}
                placeholder="UK TEXTILES - H.O"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Company Address / City</Label>
              <Input
                value={payroll.slipCompanyAddress}
                onChange={(e) => setPayroll((p) => ({ ...p, slipCompanyAddress: e.target.value }))}
                placeholder="TIRUPUR"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Minimum Rate of Wages (₹)</Label>
              <Input
                type="number"
                value={payroll.minWageRate}
                onChange={(e) => setPayroll((p) => ({ ...p, minWageRate: Number(e.target.value) }))}
                placeholder="20000"
              />
            </div>
          </div>

          {/* Signature Image Upload */}
          <div className="space-y-2">
            <Label className="text-xs">Authorised Signatory Signature Image</Label>
            <p className="text-xs text-gray-500">
              This signature will appear on all salary slips in the Proprietor section.
            </p>
            <div className="flex items-start gap-4">
              {payroll.signatureImage ? (
                <div className="relative">
                  <img
                    src={payroll.signatureImage}
                    alt="Signature"
                    className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                  />
                  <button
                    onClick={() => setPayroll((p) => ({ ...p, signatureImage: null }))}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <Upload size={18} className="text-gray-400 mb-1" />
                  <span className="text-xs text-gray-400">Upload signature</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const dataUrl = await compressImageToDataUrl(file, { maxWidth: 600, maxHeight: 600 });
                        setPayroll((p) => ({ ...p, signatureImage: dataUrl }));
                      } catch (err) {
                        toast({
                          title: "Couldn't process that image",
                          description: err instanceof Error ? err.message : undefined,
                          variant: "destructive",
                        });
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          {/* Company Logo -used on Resignation Acceptance Letter PDF */}
          <div className="space-y-2 pt-2 border-t border-gray-100">
            <Label className="text-xs">Company Logo</Label>
            <p className="text-xs text-gray-500">Used on the Resignation Acceptance Letter PDF header.</p>
            <div className="flex items-start gap-4">
              {payroll.companyLogo ? (
                <div className="relative">
                  <img
                    src={payroll.companyLogo}
                    alt="Company Logo"
                    className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                  />
                  <button
                    onClick={() => setPayroll((p) => ({ ...p, companyLogo: null }))}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <Upload size={18} className="text-gray-400 mb-1" />
                  <span className="text-xs text-gray-400">Upload logo</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const dataUrl = await compressImageToDataUrl(file, { maxWidth: 600, maxHeight: 600 });
                        setPayroll((p) => ({ ...p, companyLogo: dataUrl }));
                      } catch (err) {
                        toast({
                          title: "Couldn't process that image",
                          description: err instanceof Error ? err.message : undefined,
                          variant: "destructive",
                        });
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          {/* Authorised Signature for Resignation Letter */}
          <div className="space-y-2">
            <Label className="text-xs">Authorised Signature (for Resignation Letter)</Label>
            <p className="text-xs text-gray-500">
              This signature appears on the Resignation Acceptance Letter PDF issued to employees.
            </p>
            <div className="flex items-start gap-4">
              {payroll.authorizedSignature ? (
                <div className="relative">
                  <img
                    src={payroll.authorizedSignature}
                    alt="Authorised Signature"
                    className="h-20 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                  />
                  <button
                    onClick={() => setPayroll((p) => ({ ...p, authorizedSignature: null }))}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center w-40 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <Upload size={18} className="text-gray-400 mb-1" />
                  <span className="text-xs text-gray-400">Upload signature</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const dataUrl = await compressImageToDataUrl(file, { maxWidth: 600, maxHeight: 600 });
                        setPayroll((p) => ({ ...p, authorizedSignature: dataUrl }));
                      } catch (err) {
                        toast({
                          title: "Couldn't process that image",
                          description: err instanceof Error ? err.message : undefined,
                          variant: "destructive",
                        });
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          <Button size="sm" onClick={() => saveSalarySlip()} disabled={updatePayrollSettings.isPending}>
            {updatePayrollSettings.isPending ? "Saving…" : "Save Salary Slip Settings"}
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
