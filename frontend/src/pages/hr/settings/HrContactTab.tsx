import { useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Headset, LifeBuoy, Lock, MonitorSmartphone, Server, UserRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  getPayrollSettingsQueryKey,
  getSupportContactQueryKey,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { SupportContactView } from "@/components/SupportContactCard";
import {
  CONTACT_FORM_KEYS,
  previewFromForm,
  validateContactField,
  validateContactForm,
  type ContactForm,
} from "@/lib/support-contact";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection, type Affect } from "./kit/SettingBlock";
import { HR_CONTACT_SETTINGS } from "./HrContactTab.meta";
import { errorText } from "./identity/errors";
import { metaOf } from "./identity/meta";
import { SaveFooter } from "./identity/SaveFooter";
import { useDraft } from "./identity/useDraft";
import { dialFor, looksForeign, whatsappNumberFor } from "./hr-contact/preview";

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

const fromSettings = (s: PayrollSettingsItem | undefined): ContactForm =>
  s ? (Object.fromEntries(CONTACT_FORM_KEYS.map((k) => [k, s[k] ?? ""])) as ContactForm) : EMPTY;

type Who = "hr" | "support";
type Kind = "Name" | "Phone" | "Whatsapp" | "Email" | "Hours";
const KINDS: Kind[] = ["Name", "Phone", "Whatsapp", "Email", "Hours"];
const keyOf = (who: Who, kind: Kind) => `${who}Contact${kind}` as keyof ContactForm;
const META_ID: Record<Kind, string> = {
  Name: "name",
  Phone: "phone",
  Whatsapp: "whatsapp",
  Email: "email",
  Hours: "hours",
};

const PLACEHOLDER: Record<Who, Record<Kind, string>> = {
  hr: {
    Name: "HR Department",
    Phone: "0421 430 0800",
    Whatsapp: "98765 43210",
    Email: "hr@uktextiles.in",
    Hours: "Mon-Sat, 9:00 AM - 6:00 PM",
  },
  support: {
    Name: "Software Support",
    Phone: "98765 43210",
    Whatsapp: "98765 43210",
    Email: "support@uktextiles.in",
    Hours: "Every day, 8:00 AM - 10:00 PM",
  },
};

const WHATSAPP_RULE =
  "The server builds the chat link for Indian numbers: it drops a leading 0 and puts 91 in front unless the number already starts with 91 and ten more digits. A number from another country also gets 91 in front, so it will not open the right chat.";

function affectsFor(who: Who, kind: Kind): Affect[] {
  const card = who === "hr" ? "HR contact card" : "Server-down contact card";
  switch (kind) {
    case "Name":
      return who === "hr"
        ? [
            {
              where: "Help pages",
              what: "the heading of the HR card in the Employee Web App and the Employee Mobile App",
            },
            {
              where: "Server-down screens",
              what: "the heading there too, while no separate software support contact is set",
            },
            {
              where: "Sign-in screens",
              what: 'these print their own heading ("Can\'t sign in?"); the Employee Web App adds "Contact <name>" under it, the Mobile App and the portal\'s sign-in page do not show the name',
              to: "/employee-login",
            },
          ]
        : [
            {
              where: "Server-down screens",
              what: "the heading of the card on the portal's server-error, database-offline and connection screens, the Employee Web App's offline banner and the Mobile App's sign-in when the server cannot be reached",
            },
            { where: "Help pages", what: "the heading of the second card in both employee apps" },
          ];
    case "Phone":
      return [
        { where: card, what: 'a "Call <number>" button that dials it' },
        ...(who === "hr"
          ? [
              {
                where: "Server-down screens",
                what: "the same button, while no software support contact is set",
              },
              {
                where: "Whether a contact is shown at all",
                what: 'until a phone, WhatsApp or email is filled in, the apps print "Please contact your HR department." instead of a card',
              },
            ]
          : [
              {
                where: "Fallback to HR",
                what: "filling in a phone, WhatsApp or email here stops the server-down screens from showing the HR contact instead",
              },
            ]),
      ];
    case "Whatsapp":
      return [{ where: card, what: 'a "WhatsApp <number>" button that opens a WhatsApp chat (a wa.me link)' }];
    case "Email":
      return [
        { where: card, what: "a button that opens a new email to this address" },
        ...(who === "hr" ? [{ where: 'Mobile App "account deactivated" screen', what: 'its "write to HR" link' }] : []),
      ];
    case "Hours":
      return [
        {
          where: who === "hr" ? "Help, deactivated and server-down screens" : "Server-down screens and Help pages",
          what: "a clock line under the buttons",
        },
        ...(who === "hr"
          ? [
              {
                where: "Sign-in screens",
                what: "also shown on the compact cards of the Employee Web App and Mobile App, not on the portal's own sign-in page",
              },
            ]
          : []),
      ];
  }
}

const NOTES: Partial<Record<Kind, string>> = {
  Phone:
    "Each app keeps the last details it fetched, so a phone that has not reached the server since still shows the old number.",
  Whatsapp: WHATSAPP_RULE,
  Email: "Not the address emails are sent from (SMTP / Email tab), and not printed on documents (Company tab).",
  Hours: "Hours alone do not count as a way to reach someone: fill in a phone, WhatsApp or email as well.",
};

export default function HrContactTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdatePayrollSettings();
  const { data: settings } = usePayrollSettings();

  const saved = useMemo(() => fromSettings(settings), [settings]);
  const { form, set, discard, dirty } = useDraft(saved);

  // The contacts are one company-wide answer (the employee apps and their sign-in screens can't tell which branch
  // someone is from), so a branch login can read them but not change them. Same flag as the Late Detection rules.
  const editable = settings?.companyWideRulesEditable !== false;
  const disabled = readOnly || !editable || !settings;
  const problem = validateContactForm(form);
  const preview = useMemo(() => previewFromForm(form, settings?.companyName ?? ""), [form, settings?.companyName]);
  const supportFallsBack = preview.support.usesHrFallback;

  const save = async () => {
    if (problem) {
      toast({ title: "Check the contact details", description: problem, variant: "destructive" });
      return;
    }
    try {
      const result = await update.mutateAsync(
        Object.fromEntries(CONTACT_FORM_KEYS.map((k) => [k, form[k].trim()])) as Partial<ContactForm>,
      );
      queryClient.setQueryData(getPayrollSettingsQueryKey(), result);
      discard();
      // The employee apps read the same record; refresh this browser's copy too.
      queryClient.invalidateQueries({ queryKey: getSupportContactQueryKey() });
      toast({
        title: "HR contact details saved",
        description:
          "The Employee Web App and Mobile App show them the next time they reach the server; until then a phone keeps the copy it already has.",
      });
    } catch (e) {
      toast({ title: "Couldn't save the HR contact details", description: errorText(e), variant: "destructive" });
    }
  };

  const previewFor = (who: Who, kind: Kind): ReactNode => {
    const value = form[keyOf(who, kind)].trim();
    const lines: ReactNode[] = [];
    if (kind === "Name") {
      const label = value || PLACEHOLDER[who].Name;
      lines.push(<PreviewLine key="h" label="Card heading" result={label} />);
      if (who === "hr")
        lines.push(<PreviewLine key="w" label="Employee Web App sign-in screens" result={`Contact ${label}`} />);
    } else if (!value) {
      lines.push(
        <PreviewLine
          key="none"
          label={kind === "Hours" ? "No hours line" : "No button"}
          result="nothing is shown for this"
          tone="neutral"
        />,
      );
    } else if (kind === "Phone") {
      lines.push(<PreviewLine key="p" label={`Call ${value}`} result={`dials tel:${dialFor(value)}`} tone="good" />);
    } else if (kind === "Whatsapp") {
      lines.push(
        <PreviewLine
          key="w"
          label={`WhatsApp ${value}`}
          result={`opens wa.me/${whatsappNumberFor(value)}`}
          tone={looksForeign(value) ? "warn" : "good"}
          testId={`whatsapp-link-${who}`}
        />,
      );
      if (looksForeign(value))
        lines.push(
          <PreviewLine
            key="f"
            label="A number from another country"
            result="will not open the right chat"
            tone="warn"
          />,
        );
    } else if (kind === "Email") {
      lines.push(<PreviewLine key="e" label={value} result={`opens mailto:${value}`} tone="good" />);
    } else {
      lines.push(<PreviewLine key="t" label="Clock line" result={value} />);
    }
    if (who === "support" && kind !== "Name" && supportFallsBack)
      lines.push(
        <PreviewLine
          key="fb"
          label="Nothing filled in for support yet"
          result="server-down screens show the HR contact"
          tone="info"
        />,
      );
    return (
      <PreviewCard title="What employees get" scenario="From what is typed here, before saving.">
        {lines}
      </PreviewCard>
    );
  };

  const block = (who: Who, kind: Kind) => {
    const key = keyOf(who, kind);
    const meta = metaOf(HR_CONTACT_SETTINGS, `${who}-${META_ID[kind]}`);
    const fieldProblem = validateContactField(key, form[key]);
    const inputId = `hr-contact-${key}`;
    return (
      <SettingBlock
        key={key}
        {...meta}
        labelFor={inputId}
        affects={affectsFor(who, kind)}
        defaultText={kind === "Name" ? PLACEHOLDER[who].Name : "Blank"}
        note={NOTES[kind]}
        preview={previewFor(who, kind)}
      >
        <Input
          id={inputId}
          type={kind === "Phone" || kind === "Whatsapp" ? "tel" : kind === "Email" ? "email" : "text"}
          value={form[key]}
          disabled={disabled}
          placeholder={PLACEHOLDER[who][kind]}
          aria-invalid={fieldProblem ? true : undefined}
          aria-describedby={fieldProblem ? `${inputId}-error` : undefined}
          onChange={(e) => set(key, e.target.value)}
          data-testid={`input-${key}`}
        />
        {fieldProblem && (
          <p id={`${inputId}-error`} className="text-xs font-medium text-red-600" role="alert">
            {fieldProblem}
          </p>
        )}
      </SettingBlock>
    );
  };

  const noteProblem = validateContactField("contactNote", form.contactNote);

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Headset}
        title="HR & Software Support Contacts"
        purpose="The people employees are told to contact when they need help. It is one company-wide answer, published to the Employee Web App, the Employee Mobile App and the portal's own sign-in and server-down screens, so this is the only place to keep it up to date. Company details for documents stay on the Company tab."
        usedBy={[
          { label: "Employee Web App" },
          { label: "Employee Mobile App" },
          { label: "Employee sign-in page", to: "/employee-login" },
          { label: "Server-down screens" },
        ]}
      >
        {!editable && (
          <div
            className="mb-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
            data-testid="company-wide-notice"
          >
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>
              These contacts are company-wide, so only an administrator can change them. You can see what employees are
              shown below.
            </span>
          </div>
        )}
        <div className="grid gap-3 text-xs md:grid-cols-2">
          <div className="flex gap-2.5 rounded-lg border p-3">
            <UserRound size={16} className="mt-0.5 shrink-0 text-emerald-600" />
            <div>
              <p className="font-bold text-gray-800">HR Department is shown when…</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-gray-600">
                <li>an employee can't sign in to the Mobile App or the Web App, or set a password</li>
                <li>their account is deactivated or they have resigned</li>
                <li>they open Help in either app, or their ID card does not load</li>
              </ul>
            </div>
          </div>
          <div className="flex gap-2.5 rounded-lg border p-3">
            <Server size={16} className="mt-0.5 shrink-0 text-red-500" />
            <div>
              <p className="font-bold text-gray-800">Software Support is shown when…</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-gray-600">
                <li>the server is not working or can't be reached, or the database is offline</li>
                <li>they open Help in either app</li>
                <li>
                  if nothing is filled in for it, the <b>HR contact</b> is shown there instead
                </li>
              </ul>
            </div>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-gray-500">
          <Globe size={13} className="mt-0.5 shrink-0" />
          Public on purpose: anyone can read these details without signing in, because the sign-in screens need them.
          Each app also keeps the last copy on the device for when the server is down.
        </p>
      </SettingsSection>

      <SettingsSection
        icon={UserRound}
        title="HR Department"
        purpose="For sign-in problems, deactivated accounts and anything about the apps."
      >
        {KINDS.map((kind) => block("hr", kind))}
      </SettingsSection>

      <SettingsSection
        icon={Server}
        title="Software / IT Support"
        purpose="For when the server or the database is not working. Leave it all blank and those screens show the HR contact instead."
      >
        {KINDS.map((kind) => block("support", kind))}
      </SettingsSection>

      <SettingsSection icon={LifeBuoy} title="Note for employees">
        <SettingBlock
          {...metaOf(HR_CONTACT_SETTINGS, "contact-note")}
          labelFor="hr-contact-contactNote"
          affects={[
            {
              where: "Full contact cards",
              what: "printed under the buttons on the Employee Web App's deactivated page and Help, the Mobile App's Help and deactivated screens, and the portal's server-down screens",
            },
            { where: "Sign-in screens", what: "not shown (their cards are compact)" },
          ]}
          defaultText="Blank"
          note="Public, like the contacts. Up to 500 characters; line breaks are kept. It is hidden while no contact is filled in."
        >
          <Textarea
            id="hr-contact-contactNote"
            rows={3}
            value={form.contactNote}
            disabled={disabled}
            placeholder="For example: HR office is on the first floor of the admin block. For urgent salary queries, call before 11 AM."
            onChange={(e) => set("contactNote", e.target.value)}
            data-testid="input-contactNote"
          />
          {noteProblem ? (
            <p className="text-xs font-medium text-red-600" role="alert">
              {noteProblem}
            </p>
          ) : (
            <p className="text-xs text-gray-400">{form.contactNote.trim().length}/500</p>
          )}
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={MonitorSmartphone}
        title="What employees will see"
        purpose="A preview of your entries, before saving. The buttons here don't dial or send anything."
        testId="hr-contact-preview"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Can't sign in / app problem
            </p>
            <SupportContactView situation="hr" data={preview} preview />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Server not working</p>
            <SupportContactView situation="server" data={preview} preview />
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-snug text-gray-500">
          These are the full cards of the Help, deactivated and server-down screens. Sign-in screens show a compact
          card: one row of buttons under their own heading, without the note (and, on the portal's sign-in page, without
          the hours).
        </p>
      </SettingsSection>

      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={save}
        onDiscard={discard}
        saveLabel="Save HR Contact"
        disabled={disabled || !dirty || Boolean(problem)}
        hint={
          !settings
            ? "Loading the saved contacts…"
            : !editable
              ? "Company-wide: only an administrator can change these."
              : dirty
                ? problem
                  ? "Unsaved changes - fix the highlighted field first."
                  : "Unsaved changes - employees keep seeing the saved details until you save."
                : undefined
        }
      />
    </div>
  );
}
