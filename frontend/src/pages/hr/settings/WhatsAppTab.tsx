import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, MessageCircle, CheckCircle2 } from "lucide-react";
import {
  useWhatsAppStatus,
  useWhatsAppTemplates,
  useUpdateWhatsAppTemplate,
  type WhatsAppDocumentType,
} from "@/lib/api-client/custom-hooks";

const WHATSAPP_DOCUMENT_TYPES: { value: WhatsAppDocumentType; label: string }[] = [
  { value: "salary_slip", label: "Salary Slip" },
  { value: "id_card", label: "ID Card" },
  { value: "offer_letter", label: "Offer Letter" },
  { value: "experience_letter", label: "Experience Letter" },
  { value: "resignation_letter", label: "Resignation Letter" },
  { value: "other", label: "Other Employee Documents" },
  { value: "visitor_notification", label: "Visitor Notification (Reception)" },
];

function WhatsAppTemplateRow({ documentType, label }: { documentType: WhatsAppDocumentType; label: string }) {
  const { toast } = useToast();
  const { data: templates } = useWhatsAppTemplates();
  const updateTemplate = useUpdateWhatsAppTemplate();
  const existing = templates?.find((t) => t.documentType === documentType);

  const [templateId, setTemplateId] = useState("");
  const [variableNote, setVariableNote] = useState("");
  const [isEnabled, setIsEnabled] = useState(false);

  useEffect(() => {
    if (existing) {
      setTemplateId(existing.gupshupTemplateId);
      setVariableNote(existing.variableNote);
      setIsEnabled(existing.isEnabled);
    }
  }, [existing?.gupshupTemplateId, existing?.variableNote, existing?.isEnabled]);

  const save = async () => {
    try {
      await updateTemplate.mutateAsync({
        documentType,
        data: { gupshupTemplateId: templateId, variableNote, isEnabled },
      });
      toast({ title: `${label} WhatsApp template saved` });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  return (
    <div className="p-3 rounded-lg border border-gray-200 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800">{label}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{isEnabled ? "Enabled" : "Disabled"}</span>
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Gupshup Template ID</Label>
        <Input
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          placeholder="e.g. 8f2a1c3e-...-template-id"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Variable Note (for your reference only)</Label>
        <Input
          value={variableNote}
          onChange={(e) => setVariableNote(e.target.value)}
          placeholder="{{1}}=employee name, {{2}}=month/year"
        />
      </div>
      <Button size="sm" variant="outline" onClick={save} disabled={updateTemplate.isPending}>
        {updateTemplate.isPending ? "Saving…" : "Save Template"}
      </Button>
    </div>
  );
}

function WhatsAppSettingsCard() {
  const { data: status, isLoading: statusLoading } = useWhatsAppStatus();

  return (
    <div className="space-y-4">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <MessageCircle size={15} className="text-emerald-500" /> Gupshup WhatsApp API
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-xs text-amber-700">
            Credentials (API key, app name, source number) are configured directly in the server's <code>.env</code>{" "}
            file, never stored in the database or entered here -this keeps them out of reach of anything that reads
            Settings data, including database backups.
          </div>
          {statusLoading ? (
            <div className="h-10 w-full rounded-lg bg-gray-100 animate-pulse" />
          ) : status?.configured ? (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-100 text-xs text-green-700">
              <CheckCircle2 size={14} />
              <span>
                Configured -source number ending in <strong>…{status.sourceNumber}</strong>, app{" "}
                <strong>{status.appName}</strong>.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-100 text-xs text-red-700">
              <AlertTriangle size={14} />
              <span>
                Not configured -set <code>GUPSHUP_API_KEY</code>, <code>GUPSHUP_APP_NAME</code>, and{" "}
                <code>GUPSHUP_SOURCE_NUMBER</code> in <code>.env</code> and restart the server.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <MessageCircle size={15} className="text-emerald-500" /> Message Templates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
            WhatsApp requires every business-initiated message (rather than a reply to the customer) to use a
            pre-approved template -its wording can't be freely edited here, only which approved template gets used per
            document type. Create and get templates approved on your <strong>Gupshup dashboard → Templates</strong>{" "}
            first, then paste the approved template's ID below. A document type stays disabled (send attempts fail with
            a clear error) until a template ID is set and the toggle is turned on.
          </div>
          <div className="grid gap-3">
            {WHATSAPP_DOCUMENT_TYPES.map(({ value, label }) => (
              <WhatsAppTemplateRow key={value} documentType={value} label={label} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function WhatsAppTab() {
  return (
    <>
      <WhatsAppSettingsCard />
    </>
  );
}
