import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Building2, Upload, X } from "lucide-react";
import { usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";
import { compressImageToDataUrl } from "@/lib/image-compression";

// Logo/signature uploads are compressed with compressImageToDataUrl before they become the base64
// data URI sent in the JSON PUT (see config/settings.py DATA_UPLOAD_MAX_MEMORY_SIZE).

export default function CompanyTab() {
  const { toast } = useToast();
  const updatePayrollSettings = useUpdatePayrollSettings();
  const { data: payrollSettingsData } = usePayrollSettings();

  // Only the logo is shared with the Salary Slip tab; each tab keeps its own copy
  // and re-syncs from the server after a save.
  const [payroll, setPayroll] = useState({ companyLogo: null as string | null });

  // ── Company profile -persisted to PayrollSettings via the API ─────────
  const [company, setCompany] = useState({
    name: "UKTextiles",
    tagline: "Garments Manufacturing Excellence",
    address: "Chennai, Tamil Nadu, India",
    phone: "+91 9876543210",
    email: "hr@uktextiles.in",
    website: "https://uktextiles.in",
    gstin: "",
    pan: "",
    registration: "",
  });

  useEffect(() => {
    if (!payrollSettingsData) return;
    setCompany({
      name: payrollSettingsData.companyName || "UKTextiles",
      tagline: payrollSettingsData.companyTagline || "Garments Manufacturing Excellence",
      phone: payrollSettingsData.companyPhone || "",
      email: payrollSettingsData.companyEmail || "",
      website: payrollSettingsData.companyWebsite || "",
      gstin: payrollSettingsData.companyGstin || "",
      pan: payrollSettingsData.companyPan || "",
      address: payrollSettingsData.companyAddress || "",
      registration: payrollSettingsData.companyRegistration || "",
    });
    setPayroll({ companyLogo: payrollSettingsData.companyLogo || null });
  }, [payrollSettingsData]);

  const saveCompany = async () => {
    try {
      await updatePayrollSettings.mutateAsync({
        companyName: company.name,
        companyTagline: company.tagline,
        companyPhone: company.phone,
        companyEmail: company.email,
        companyWebsite: company.website,
        companyGstin: company.gstin,
        companyPan: company.pan,
        companyAddress: company.address,
        companyRegistration: company.registration,
        // null is meaningful here -it clears a previously saved logo
        companyLogo: payroll.companyLogo,
      } as never);
      toast({
        title: "Company settings saved",
        description: "The name and logo now update everywhere in the portal, including the sidebar.",
      });
    } catch {
      toast({ title: "Failed to save company settings", variant: "destructive" });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Building2 size={15} className="text-blue-500" /> Company Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
            These details are used across the entire portal -the sidebar, salary slips, ID cards, and PDFs all pull the
            name and logo from here automatically.
          </div>

          {/* Logo upload */}
          <div className="space-y-2">
            <Label className="text-xs">Company Logo</Label>
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

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Company Name</Label>
              <Input value={company.name} onChange={(e) => setCompany((c) => ({ ...c, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tagline</Label>
              <Input value={company.tagline} onChange={(e) => setCompany((c) => ({ ...c, tagline: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Phone</Label>
              <Input value={company.phone} onChange={(e) => setCompany((c) => ({ ...c, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input
                type="email"
                value={company.email}
                onChange={(e) => setCompany((c) => ({ ...c, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Website</Label>
              <Input value={company.website} onChange={(e) => setCompany((c) => ({ ...c, website: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">GSTIN</Label>
              <Input
                value={company.gstin}
                onChange={(e) => setCompany((c) => ({ ...c, gstin: e.target.value }))}
                placeholder="27XXXXX..."
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">PAN</Label>
              <Input value={company.pan} onChange={(e) => setCompany((c) => ({ ...c, pan: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Registration Details</Label>
              <Input
                value={company.registration}
                onChange={(e) => setCompany((c) => ({ ...c, registration: e.target.value }))}
                placeholder="CIN / factory license no."
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Address</Label>
            <Input value={company.address} onChange={(e) => setCompany((c) => ({ ...c, address: e.target.value }))} />
          </div>
          <Button size="sm" onClick={saveCompany} disabled={updatePayrollSettings.isPending}>
            {updatePayrollSettings.isPending ? "Saving…" : "Save Company Settings"}
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
