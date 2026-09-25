import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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

function WhatsAppMessageRow({ documentType, label }: { documentType: WhatsAppDocumentType; label: string }) {
  const { toast } = useToast();
  const { data: templates } = useWhatsAppTemplates();
  const updateTemplate = useUpdateWhatsAppTemplate();
  const existing = templates?.find((t) => t.documentType === documentType);

  const [messageBody, setMessageBody] = useState("");
  const [isEnabled, setIsEnabled] = useState(true);

  useEffect(() => {
    if (existing) {
      setMessageBody(existing.messageBody);
      setIsEnabled(existing.isEnabled);
    }
  }, [existing?.messageBody, existing?.isEnabled]);

  const save = async () => {
    try {
      await updateTemplate.mutateAsync({ documentType, data: { messageBody, isEnabled } });
      toast({ title: `${label} WhatsApp message saved` });
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
        <Label className="text-xs">Message text</Label>
        <Textarea
          rows={5}
          value={messageBody}
          onChange={(e) => setMessageBody(e.target.value)}
          placeholder={existing?.defaultMessage ?? ""}
        />
        <p className="text-[11px] text-gray-400">
          Leave blank to send the default shown above. Placeholders: {existing?.placeholders}
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={save} disabled={updateTemplate.isPending}>
          {updateTemplate.isPending ? "Saving…" : "Save Message"}
        </Button>
        {messageBody && (
          <Button size="sm" variant="ghost" onClick={() => setMessageBody("")}>
            Use default
          </Button>
        )}
      </div>
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
            <MessageCircle size={15} className="text-emerald-500" /> WAClient WhatsApp API
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-xs text-amber-700">
            Credentials (instance ID and access token) are configured directly in the server's <code>.env</code> file,
            never stored in the database or entered here -this keeps them out of reach of anything that reads Settings
            data, including database backups.
          </div>
          {statusLoading ? (
            <div className="h-10 w-full rounded-lg bg-gray-100 animate-pulse" />
          ) : status?.configured ? (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-100 text-xs text-green-700">
              <CheckCircle2 size={14} />
              <span>
                Configured -instance ending in <strong>{status.instanceId}</strong>.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-100 text-xs text-red-700">
              <AlertTriangle size={14} />
              <span>
                Not configured -set <code>WACLIENT_INSTANCE_ID</code> and <code>WACLIENT_ACCESS_TOKEN</code> in{" "}
                <code>.env</code> and restart the server.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <MessageCircle size={15} className="text-emerald-500" /> Message Text
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700">
            Messages go out through the WhatsApp number linked to your WAClient instance, so there are no templates to
            get approved -edit the wording freely. Use <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code> … where the
            employee's name, the month and so on should appear. Every document type works out of the box with the
            default text; turn a type off here to stop it being sent.
          </div>
          <div className="grid gap-3">
            {WHATSAPP_DOCUMENT_TYPES.map(({ value, label }) => (
              <WhatsAppMessageRow key={value} documentType={value} label={label} />
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
