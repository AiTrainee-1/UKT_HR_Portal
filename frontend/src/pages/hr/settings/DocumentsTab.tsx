import { useEffect, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { IndianRupee, FileText, Upload, X, FileSignature, Award } from "lucide-react";
import {
  useDocumentSettings,
  useUpdateDocumentSettings,
  previewDocumentPdf,
  type DocumentType,
} from "@/lib/api-client/custom-hooks";
import { useAuth } from "@/contexts/AuthContext";
import { compressImageToDataUrl } from "@/lib/image-compression";

function DocumentThemeCard({
  docType,
  title,
  icon,
  description,
}: {
  docType: DocumentType;
  title: string;
  icon: ReactNode;
  description: string;
}) {
  const { toast } = useToast();
  const { token } = useAuth();
  const { data, isLoading } = useDocumentSettings(docType);
  const updateSettings = useUpdateDocumentSettings(docType);
  const [form, setForm] = useState({
    primaryColor: "#0E4B3A",
    accentColor: "#C9A227",
    headingStyle: "serif" as "serif" | "sans",
    showWatermark: true,
    footerTagline: "Weaving Quality. Building Trust.",
    logoOverride: "",
  });
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        primaryColor: data.primaryColor,
        accentColor: data.accentColor,
        headingStyle: data.headingStyle,
        showWatermark: data.showWatermark,
        footerTagline: data.footerTagline,
        logoOverride: data.logoOverride,
      });
    }
  }, [data]);

  const save = async () => {
    try {
      await updateSettings.mutateAsync(form);
      toast({ title: `${title} settings saved`, description: "Applies to every newly generated document." });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      await previewDocumentPdf(`/api/document-settings/${docType}/preview`, () => token);
    } catch {
      toast({ title: "Failed to generate preview", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-500">{description}</p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Theme Color (Primary)</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.primaryColor}
                  onChange={(e) => setForm((f) => ({ ...f, primaryColor: e.target.value }))}
                  className="h-9 w-12 rounded border cursor-pointer"
                />
                <Input
                  value={form.primaryColor}
                  onChange={(e) => setForm((f) => ({ ...f, primaryColor: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Accent Color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.accentColor}
                  onChange={(e) => setForm((f) => ({ ...f, accentColor: e.target.value }))}
                  className="h-9 w-12 rounded border cursor-pointer"
                />
                <Input
                  value={form.accentColor}
                  onChange={(e) => setForm((f) => ({ ...f, accentColor: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Heading Style</Label>
              <select
                value={form.headingStyle}
                onChange={(e) => setForm((f) => ({ ...f, headingStyle: e.target.value as "serif" | "sans" }))}
                className="w-full h-9 rounded-md border px-3 text-sm bg-background"
              >
                <option value="serif">Serif (elegant)</option>
                <option value="sans">Sans (modern)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Footer Tagline</Label>
              <Input
                value={form.footerTagline}
                onChange={(e) => setForm((f) => ({ ...f, footerTagline: e.target.value }))}
                placeholder="e.g. Weaving Quality. Building Trust."
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Logo Override (optional -defaults to the Company Logo above)</Label>
              <div className="flex items-start gap-4">
                {form.logoOverride ? (
                  <div className="relative">
                    <img
                      src={form.logoOverride}
                      alt="Logo override"
                      className="h-16 border border-gray-200 rounded-lg bg-white p-2 object-contain"
                    />
                    <button
                      onClick={() => setForm((f) => ({ ...f, logoOverride: "" }))}
                      className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center w-36 h-16 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-emerald-400 hover:bg-emerald-50 transition-colors">
                    <Upload size={16} className="text-gray-400 mb-1" />
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
                          setForm((f) => ({ ...f, logoOverride: dataUrl }));
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
            <div className="space-y-1.5 flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, showWatermark: !f.showWatermark }))}
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    form.showWatermark ? "bg-emerald-700 border-emerald-700" : "bg-white border-gray-300"
                  }`}
                >
                  {form.showWatermark && <span className="w-2 h-2 bg-white rounded-sm" />}
                </button>
                <span className="text-sm text-gray-700">Show faint watermark</span>
              </label>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={save} disabled={updateSettings.isPending}>
            {updateSettings.isPending ? "Saving…" : `Save ${title} Settings`}
          </Button>
          <Button size="sm" variant="outline" onClick={preview} disabled={previewing}>
            {previewing ? "Generating…" : "Preview"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DocumentsTab() {
  return (
    <>
      <p className="text-xs text-gray-500 -mt-1">
        Theme each generated document independently. Colors, heading style, and an optional logo override — everything
        else (company name, address, contact info) is pulled from the Company tab automatically.
      </p>
      <DocumentThemeCard
        docType="offer_letter"
        title="Offer Letter"
        icon={<FileSignature size={15} className="text-emerald-700" />}
        description="Generated from an employee's profile -Employees → select employee → Generate Offer Letter."
      />
      <DocumentThemeCard
        docType="experience_letter"
        title="Experience Letter"
        icon={<Award size={15} className="text-emerald-700" />}
        description="Generated from an employee's profile -Employees → select employee → Generate Experience Letter."
      />
      <DocumentThemeCard
        docType="salary_slip"
        title="Salary Slip"
        icon={<IndianRupee size={15} className="text-emerald-700" />}
        description="Applies to the Salary Slip PDF generated from the Salary Slip page."
      />
      <DocumentThemeCard
        docType="resignation_letter"
        title="Resignation Letter"
        icon={<FileText size={15} className="text-emerald-700" />}
        description="Generated from Recruitment → Resignations once a resignation is approved."
      />
    </>
  );
}
