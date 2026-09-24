import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { CreditCard } from "lucide-react";
import { useIdCardSettings, useUpdateIdCardSettings } from "@/lib/api-client/custom-hooks";

export default function IdCardTab() {
  const { toast } = useToast();

  // ── ID Card template settings ───────────────────────────────────────────
  const { data: idCardSettingsData, isLoading: idCardLoading } = useIdCardSettings();

  const updateIdCardSettings = useUpdateIdCardSettings();

  const [idCardForm, setIdCardForm] = useState({
    primaryColor: "#006496",
    secondaryColor: "#4FB8F0",
    textColor: "#0f172a",
    fontFamily: "Hanken Grotesk",
    backgroundStyle: "gradient",
    logoPosition: "left",
    cornerStyle: "rounded",
    showQrOnBack: true,
    footerText: "",
  });

  useEffect(() => {
    if (idCardSettingsData) setIdCardForm(idCardSettingsData);
  }, [idCardSettingsData]);

  const saveIdCardSettings = async () => {
    try {
      await updateIdCardSettings.mutateAsync(idCardForm);
      toast({ title: "ID card template saved", description: "Applies to all newly generated ID cards." });
    } catch {
      toast({ title: "Failed to save ID card settings", variant: "destructive" });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <CreditCard size={15} className="text-sky-500" /> Employee ID Card Template
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-gray-500">
            These settings control the look of every ID card generated from the ID Cards page.
          </p>
          {idCardLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Primary Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={idCardForm.primaryColor}
                    onChange={(e) => setIdCardForm((f) => ({ ...f, primaryColor: e.target.value }))}
                    className="h-9 w-12 rounded border cursor-pointer"
                  />
                  <Input
                    value={idCardForm.primaryColor}
                    onChange={(e) => setIdCardForm((f) => ({ ...f, primaryColor: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Secondary Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={idCardForm.secondaryColor}
                    onChange={(e) => setIdCardForm((f) => ({ ...f, secondaryColor: e.target.value }))}
                    className="h-9 w-12 rounded border cursor-pointer"
                  />
                  <Input
                    value={idCardForm.secondaryColor}
                    onChange={(e) => setIdCardForm((f) => ({ ...f, secondaryColor: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Text Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={idCardForm.textColor}
                    onChange={(e) => setIdCardForm((f) => ({ ...f, textColor: e.target.value }))}
                    className="h-9 w-12 rounded border cursor-pointer"
                  />
                  <Input
                    value={idCardForm.textColor}
                    onChange={(e) => setIdCardForm((f) => ({ ...f, textColor: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Font Family</Label>
                <select
                  value={idCardForm.fontFamily}
                  onChange={(e) => setIdCardForm((f) => ({ ...f, fontFamily: e.target.value }))}
                  className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                >
                  <option value="Hanken Grotesk">Hanken Grotesk</option>
                  <option value="Inter">Inter</option>
                  <option value="Poppins">Poppins</option>
                  <option value="Roboto">Roboto</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Background Style</Label>
                <select
                  value={idCardForm.backgroundStyle}
                  onChange={(e) => setIdCardForm((f) => ({ ...f, backgroundStyle: e.target.value }))}
                  className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                >
                  <option value="gradient">Gradient</option>
                  <option value="solid">Solid</option>
                  <option value="pattern">Pattern</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Logo Position</Label>
                <select
                  value={idCardForm.logoPosition}
                  onChange={(e) => setIdCardForm((f) => ({ ...f, logoPosition: e.target.value }))}
                  className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Corner Style</Label>
                <select
                  value={idCardForm.cornerStyle}
                  onChange={(e) => setIdCardForm((f) => ({ ...f, cornerStyle: e.target.value }))}
                  className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                >
                  <option value="rounded">Rounded</option>
                  <option value="sharp">Sharp</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Footer Text (optional)</Label>
                <Input
                  value={idCardForm.footerText}
                  onChange={(e) => setIdCardForm((f) => ({ ...f, footerText: e.target.value }))}
                  placeholder="e.g. Valid for the current calendar year"
                />
              </div>
              <div className="space-y-1.5 flex items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <button
                    type="button"
                    onClick={() => setIdCardForm((f) => ({ ...f, showQrOnBack: !f.showQrOnBack }))}
                    className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      idCardForm.showQrOnBack ? "bg-sky-600 border-sky-600" : "bg-white border-gray-300"
                    }`}
                  >
                    {idCardForm.showQrOnBack && <span className="w-2 h-2 bg-white rounded-sm" />}
                  </button>
                  <span className="text-sm text-gray-700">Show QR verification code on back</span>
                </label>
              </div>
            </div>
          )}
          <Button size="sm" onClick={saveIdCardSettings} disabled={updateIdCardSettings.isPending}>
            {updateIdCardSettings.isPending ? "Saving…" : "Save ID Card Template"}
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
