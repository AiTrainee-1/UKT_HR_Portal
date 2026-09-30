import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Headset, Info, LifeBuoy, Lock, MonitorSmartphone, Server, UserRound } from "lucide-react";
import { getSupportContactQueryKey, usePayrollSettings, useUpdatePayrollSettings } from "@/lib/api-client/custom-hooks";
import { SupportContactView } from "@/components/SupportContactCard";
import {
  CONTACT_FORM_KEYS,
  previewFromForm,
  validateContactField,
  validateContactForm,
  type ContactForm,
} from "@/lib/support-contact";

const EMPTY: ContactForm = {
  hrContactName: "",
  hrContactPhone: "",
  hrContactWhatsapp: "",
  hrContactEmail: "",
  hrContactHours: "",
  supportContactName: "",
  supportContactPhone: "",
  supportContactWhatsapp: "",
  supportContactEmail: "",
  supportContactHours: "",
  contactNote: "",
};

type FieldSpec = { key: keyof ContactForm; label: string; placeholder: string; type?: string; hint?: string };

const HR_FIELDS: FieldSpec[] = [
  { key: "hrContactName", label: "Name shown to employees", placeholder: "HR Department" },
  { key: "hrContactPhone", label: "Phone number", placeholder: "0421 430 0800", type: "tel" },
  {
    key: "hrContactWhatsapp",
    label: "WhatsApp number",
    placeholder: "98765 43210",
    type: "tel",
    hint: "Opens a WhatsApp chat. Without a country code, +91 is assumed.",
  },
  { key: "hrContactEmail", label: "Email", placeholder: "hr@uktextiles.in", type: "email" },
  { key: "hrContactHours", label: "Available hours", placeholder: "Mon–Sat, 9:00 AM – 6:00 PM" },
];

const SUPPORT_FIELDS: FieldSpec[] = [
  { key: "supportContactName", label: "Name shown to employees", placeholder: "Software Support" },
  { key: "supportContactPhone", label: "Phone number", placeholder: "98765 43210", type: "tel" },
  { key: "supportContactWhatsapp", label: "WhatsApp number", placeholder: "98765 43210", type: "tel" },
  { key: "supportContactEmail", label: "Email", placeholder: "support@uktextiles.in", type: "email" },
  { key: "supportContactHours", label: "Available hours", placeholder: "Every day, 8:00 AM – 10:00 PM" },
];

function FieldGrid({
  fields,
  form,
  disabled,
  onChange,
}: {
  fields: FieldSpec[];
  form: ContactForm;
  disabled: boolean;
  onChange: (key: keyof ContactForm, value: string) => void;
}) {
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      {fields.map(({ key, label, placeholder, type, hint }) => {
        const problem = validateContactField(key, form[key]);
        return (
          <div key={key} className="space-y-1.5">
            <Label className="text-xs" htmlFor={`hr-contact-${key}`}>
              {label}
            </Label>
            <Input
              id={`hr-contact-${key}`}
              type={type ?? "text"}
              value={form[key]}
              disabled={disabled}
              placeholder={placeholder}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `hr-contact-${key}-error` : undefined}
              onChange={(e) => onChange(key, e.target.value)}
              data-testid={`input-${key}`}
            />
            {problem ? (
              <p id={`hr-contact-${key}-error`} className="text-[11px] text-red-600" role="alert">
                {problem}
              </p>
            ) : (
              hint && <p className="text-[11px] text-gray-400">{hint}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function HrContactTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateSettings = useUpdatePayrollSettings();
  const { data: settings, isLoading } = usePayrollSettings();

  const [form, setForm] = useState<ContactForm>(EMPTY);

  // What the server holds, in the shape of the form (blank where nothing is set).
  const saved = useMemo<ContactForm>(
    () =>
      settings ? (Object.fromEntries(CONTACT_FORM_KEYS.map((k) => [k, settings[k] ?? ""])) as ContactForm) : EMPTY,
    [settings],
  );

  useEffect(() => {
    if (settings) setForm(saved);
  }, [settings, saved]);

  // The contacts are one company-wide answer (the employee apps and their sign-in screens can't tell which branch
  // someone is from), so a branch login can read them but not change them. Same flag as the Late Detection rules.
  const editable = settings?.companyWideRulesEditable !== false;
  const dirty = CONTACT_FORM_KEYS.some((k) => form[k].trim() !== saved[k].trim());
  const problem = validateContactForm(form);
  const preview = useMemo(() => previewFromForm(form, settings?.companyName ?? ""), [form, settings?.companyName]);

  const setField = (key: keyof ContactForm, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (problem) {
      toast({ title: "Check the contact details", description: problem, variant: "destructive" });
      return;
    }
    try {
      await updateSettings.mutateAsync(
        Object.fromEntries(CONTACT_FORM_KEYS.map((k) => [k, form[k].trim()])) as Partial<ContactForm>,
      );
      // The employee apps read the same record; refresh this browser's copy too.
      queryClient.invalidateQueries({ queryKey: getSupportContactQueryKey() });
      toast({
        title: "HR contact details saved",
        description: "Employees see them in the Employee Mobile App and Employee Web App from now on.",
      });
    } catch (e) {
      toast({
        title: "Couldn't save the HR contact details",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Headset size={15} className="text-blue-500" /> HR &amp; Software Support Contacts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-xs text-blue-700 flex gap-2">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              These are the people employees are told to contact for help. The same details appear in the{" "}
              <b>Employee Mobile App</b> and the <b>Employee Web App</b>, on the sign-in screens, in Help &amp; Support
              and whenever the server can't be reached, so there is only one place to keep them up to date. Company
              details and documents stay in the <b>Company</b> tab.
            </span>
          </div>

          {!editable && (
            <div
              className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex gap-2"
              data-testid="company-wide-notice"
            >
              <Lock size={14} className="mt-0.5 shrink-0" />
              <span>
                These contacts are company-wide, so only an administrator can change them. You can see what employees
                are shown below.
              </span>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg border p-3 flex gap-2.5">
              <UserRound size={16} className="text-emerald-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-bold text-gray-800">HR Department is shown when…</p>
                <ul className="mt-1 list-disc pl-4 text-gray-600 space-y-0.5">
                  <li>an employee can't sign in to the mobile app or web app (wrong password, code not arriving)</li>
                  <li>they are not registered, or their account is inactive</li>
                  <li>there is any problem with the Employee Web App or mobile app itself</li>
                </ul>
              </div>
            </div>
            <div className="rounded-lg border p-3 flex gap-2.5">
              <Server size={16} className="text-red-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-bold text-gray-800">Software Support is shown when…</p>
                <ul className="mt-1 list-disc pl-4 text-gray-600 space-y-0.5">
                  <li>the server is not working or can't be reached</li>
                  <li>the database is offline, or the app can't connect</li>
                  <li>
                    if you leave it blank, the <b>HR contact</b> is shown here instead
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <UserRound size={15} className="text-emerald-600" /> HR Department
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGrid fields={HR_FIELDS} form={form} disabled={!editable || isLoading} onChange={setField} />
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Server size={15} className="text-red-500" /> Software / IT Support
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGrid fields={SUPPORT_FIELDS} form={form} disabled={!editable || isLoading} onChange={setField} />
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <LifeBuoy size={15} className="text-blue-500" /> Note for employees
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label className="text-xs" htmlFor="hr-contact-contactNote">
            Shown under the contacts (optional)
          </Label>
          <Textarea
            id="hr-contact-contactNote"
            rows={3}
            value={form.contactNote}
            disabled={!editable || isLoading}
            placeholder="For example: HR office is on the first floor of the admin block. For urgent salary queries, call before 11 AM."
            onChange={(e) => setField("contactNote", e.target.value)}
            data-testid="input-contactNote"
          />
          {validateContactField("contactNote", form.contactNote) ? (
            <p className="text-[11px] text-red-600" role="alert">
              {validateContactField("contactNote", form.contactNote)}
            </p>
          ) : (
            <p className="text-[11px] text-gray-400">{form.contactNote.trim().length}/500</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm" data-testid="hr-contact-preview">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <MonitorSmartphone size={15} className="text-purple-500" /> What employees will see
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-gray-500">
            A preview of your entries, before saving. The buttons here don't dial or send anything.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                Can't sign in / app problem
              </p>
              <SupportContactView situation="hr" data={preview} preview />
            </div>
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Server not working</p>
              <SupportContactView situation="server" data={preview} preview />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={save}
          disabled={!editable || !dirty || Boolean(problem) || updateSettings.isPending || isLoading}
        >
          {updateSettings.isPending ? "Saving…" : "Save HR Contact"}
        </Button>
        {dirty && editable && <span className="text-xs text-amber-600">Unsaved changes</span>}
      </div>
    </div>
  );
}
