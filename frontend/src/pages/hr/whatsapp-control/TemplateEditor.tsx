import { useMemo, useState } from "react";
import { KeyRound, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateMetaTemplate,
  useMetaTemplateDraft,
  whatsAppErrorMessage,
  whatsAppFieldErrors,
  type WhatsAppTemplateDraft,
  type WhatsAppTemplateHeader,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Notice, WhatsAppPreview } from "./kit";
import { BODY_MAX, FOOTER_MAX, authTemplatePreview, checkTemplate, renderTemplate, templateVariables } from "./logic";

// Create a Meta template and submit it for approval: from an HRMS message type (the server's draft of the catalog's
// wording, prefilled and editable) or from scratch. The phone on the right shows it as the employee will see it, with
// the examples filled in; the rules Meta applies are checked as HR types, and Meta's own refusal is shown as it came.

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "en_US", label: "English (US)" },
  { value: "en_GB", label: "English (UK)" },
  { value: "hi", label: "Hindi" },
  { value: "ta", label: "Tamil" },
];

const CATEGORIES = [
  { value: "UTILITY", label: "Utility", help: "About the employee's own work (₹0.115 a message)." },
  { value: "AUTHENTICATION", label: "Authentication", help: "One-time codes only; Meta writes the text." },
  { value: "MARKETING", label: "Marketing", help: "Promotions (₹0.86 a message). The HRMS sends none." },
];

const HEADERS: { value: WhatsAppTemplateHeader; label: string }[] = [
  { value: "", label: "None" },
  { value: "document", label: "Document (PDF)" },
  { value: "image", label: "Photo" },
];

export const BLANK_DRAFT: WhatsAppTemplateDraft = {
  messageType: "",
  name: "hrms_",
  language: "en",
  category: "UTILITY",
  header: "",
  body: "Dear {{employee_name}},\n\n\n\n- UK Textiles HR",
  footer: "UK Textiles HR",
  examples: { employee_name: "Asha Kumar" },
  warnings: [],
  codeExpirationMinutes: null,
};

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

function FieldError({ text, testId }: { text?: string; testId?: string }) {
  if (!text) return null;
  return (
    <p className="text-[11px] font-medium text-red-600 dark:text-red-400" data-testid={testId}>
      {text}
    </p>
  );
}

function EditorForm({
  draft,
  label,
  onClose,
}: {
  draft: WhatsAppTemplateDraft;
  /** The message type's name, for the title ("Salary Slip"). */
  label: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateMetaTemplate();
  const [name, setName] = useState(draft.name);
  const [language, setLanguage] = useState(draft.language);
  const [category, setCategory] = useState(draft.category);
  const [header, setHeader] = useState<WhatsAppTemplateHeader>(draft.header);
  const [body, setBody] = useState(draft.body);
  const [footer, setFooter] = useState(draft.footer);
  const [examples, setExamples] = useState<Record<string, string>>(draft.examples);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});

  const isAuth = category.toUpperCase() === "AUTHENTICATION";
  const vars = useMemo(() => templateVariables(body), [body]);
  const check = checkTemplate({ name, category, body, footer, examples });
  const errors = { ...check.errors, ...serverFields };
  const blocking = Object.keys(check.errors).length > 0;
  const preview = isAuth
    ? authTemplatePreview("482913", draft.codeExpirationMinutes)
    : { body: renderTemplate(body, examples), footer };

  const touched = () => {
    setServerError(null);
    setServerFields({});
  };

  const submit = () => {
    touched();
    const usedExamples = Object.fromEntries(vars.map((v) => [v, (examples[v] ?? "").trim()]));
    create.mutate(
      {
        name: name.trim(),
        language,
        category,
        header: isAuth ? "" : header,
        body: isAuth ? "" : body,
        footer: isAuth ? "" : footer,
        examples: isAuth ? {} : usedExamples,
        ...(draft.messageType ? { messageType: draft.messageType } : {}),
        ...(isAuth && draft.codeExpirationMinutes ? { codeExpirationMinutes: draft.codeExpirationMinutes } : {}),
      },
      {
        onSuccess: (t) => {
          toast({
            title: `${t?.name ?? name.trim()} submitted to Meta`,
            description: "Meta reviews it, usually within minutes. Its status updates here by itself.",
          });
          onClose();
        },
        onError: (e) => {
          setServerFields(whatsAppFieldErrors(e));
          setServerError(whatsAppErrorMessage(e, "Meta did not accept the template."));
        },
      },
    );
  };

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]" data-testid="wa-template-editor">
      <div className="min-w-0 space-y-3.5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <div className="space-y-1">
            <Label htmlFor="wa-tpl-name" className="text-xs">
              Template name
            </Label>
            <Input
              id="wa-tpl-name"
              value={name}
              onChange={(e) => {
                touched();
                setName(e.target.value.toLowerCase().replace(/[\s-]+/g, "_"));
              }}
              className="font-mono text-sm"
              data-testid="wa-tpl-name"
              aria-invalid={Boolean(errors.name)}
            />
            <FieldError text={errors.name} testId="wa-tpl-name-error" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wa-tpl-language" className="text-xs">
              Language
            </Label>
            <select
              id="wa-tpl-language"
              className={SELECT}
              value={language}
              onChange={(e) => {
                touched();
                setLanguage(e.target.value);
              }}
              data-testid="wa-tpl-language"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="wa-tpl-category" className="text-xs">
              Category
            </Label>
            <select
              id="wa-tpl-category"
              className={SELECT}
              value={category}
              onChange={(e) => {
                touched();
                setCategory(e.target.value);
              }}
              data-testid="wa-tpl-category"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {CATEGORIES.find((c) => c.value === category.toUpperCase())?.help}
            </p>
          </div>
          {!isAuth && (
            <div className="space-y-1">
              <Label htmlFor="wa-tpl-header" className="text-xs">
                Attachment
              </Label>
              <select
                id="wa-tpl-header"
                className={SELECT}
                value={header}
                onChange={(e) => {
                  touched();
                  setHeader(e.target.value as WhatsAppTemplateHeader);
                }}
                data-testid="wa-tpl-header"
              >
                {HEADERS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">The file travels at the top of the message.</p>
            </div>
          )}
        </div>

        {isAuth ? (
          <Notice tone="info" icon={KeyRound} testId="wa-tpl-auth-note">
            Meta writes the text of a code template itself: the code, a line asking not to share it,
            {draft.codeExpirationMinutes ? ` "expires in ${draft.codeExpirationMinutes} minutes",` : ""} and a{" "}
            <b>Copy code</b> button. The code expiry comes from the OTP tab.
          </Notice>
        ) : (
          <>
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="wa-tpl-body" className="text-xs">
                  Message
                </Label>
                <span
                  className={cn(
                    "text-[11px] tabular-nums",
                    body.length > BODY_MAX ? "text-red-600" : "text-muted-foreground",
                  )}
                >
                  {body.length} / {BODY_MAX}
                </span>
              </div>
              <Textarea
                id="wa-tpl-body"
                value={body}
                rows={8}
                onChange={(e) => {
                  touched();
                  setBody(e.target.value);
                }}
                className="font-mono text-[13px] leading-relaxed"
                data-testid="wa-tpl-body"
                aria-invalid={Boolean(errors.body)}
              />
              <FieldError text={errors.body} testId="wa-tpl-body-error" />
              <p className="text-[11px] text-muted-foreground">
                Write variables as {"{{employee_name}}"}. *bold* and _italic_ work as on the phone.
              </p>
            </div>

            {vars.length > 0 && (
              <div className="space-y-2 rounded-xl border bg-muted/50 p-3" data-testid="wa-tpl-variables">
                <p className="text-xs font-semibold">Examples Meta reviews the template with</p>
                {vars.map((v) => (
                  <div key={v} className="grid items-center gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-2">
                    <Label htmlFor={`wa-tpl-ex-${v}`} className="truncate font-mono text-[12px]">
                      {`{{${v}}}`}
                    </Label>
                    <div className="space-y-0.5">
                      <Input
                        id={`wa-tpl-ex-${v}`}
                        value={examples[v] ?? ""}
                        onChange={(e) => {
                          touched();
                          setExamples((prev) => ({ ...prev, [v]: e.target.value }));
                        }}
                        className="h-8 text-[13px]"
                        data-testid={`wa-tpl-example-${v}`}
                        aria-invalid={Boolean(errors[`example:${v}`])}
                      />
                      <FieldError text={errors[`example:${v}`]} testId={`wa-tpl-example-error-${v}`} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="wa-tpl-footer" className="text-xs">
                  Footer
                </Label>
                <span
                  className={cn(
                    "text-[11px] tabular-nums",
                    footer.length > FOOTER_MAX ? "text-red-600" : "text-muted-foreground",
                  )}
                >
                  {footer.length} / {FOOTER_MAX}
                </span>
              </div>
              <Input
                id="wa-tpl-footer"
                value={footer}
                onChange={(e) => {
                  touched();
                  setFooter(e.target.value);
                }}
                className="h-9 text-[13px]"
                data-testid="wa-tpl-footer"
              />
              <FieldError text={errors.footer} testId="wa-tpl-footer-error" />
            </div>
          </>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label ? `${label}, as the employee sees it` : "As the employee sees it"}
        </p>
        <WhatsAppPreview
          body={preview.body}
          header={isAuth ? "" : header}
          footer={preview.footer}
          buttons={isAuth ? ["Copy code"] : []}
          testId="wa-tpl-preview"
        />
        {[...draft.warnings, ...check.warnings].map((w) => (
          <Notice key={w} tone="warn" testId="wa-tpl-warning">
            {w}
          </Notice>
        ))}
        {serverError && (
          <Notice tone="bad" role="alert" title="Not submitted" testId="wa-tpl-server-error">
            {serverError}
          </Notice>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={submit}
            disabled={blocking || create.isPending}
            data-testid="wa-tpl-submit"
          >
            <Send size={13} /> {create.isPending ? "Submitting…" : "Submit to Meta"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The editor in a dialog. `messageType` asks the server for that type's draft; null opens a blank template; `draft`
 * starts from a given one (the OTP tab's code template, a rejected template being fixed).
 */
export default function TemplateEditorDialog({
  open,
  onClose,
  messageType = null,
  label = null,
  draft = null,
  types = [],
}: {
  open: boolean;
  onClose: () => void;
  messageType?: string | null;
  label?: string | null;
  draft?: WhatsAppTemplateDraft | null;
  /** For a new template: the HRMS message types it can start from (their wording is turned into a draft). */
  types?: { type: string; label: string }[];
}) {
  // a new template may start from a message type HR picks here
  const [picked, setPicked] = useState("");
  const type = messageType ?? (picked || null);
  const typeLabel = label ?? types.find((t) => t.type === picked)?.label ?? null;
  const fetched = useMetaTemplateDraft(open && !draft ? type : null);
  const start = draft ?? (type ? (fetched.data ?? null) : BLANK_DRAFT);
  // a new draft (another type, or the server's answer arriving) starts the form again
  const formKey = draft ? "given" : type ? `${type}:${fetched.dataUpdatedAt}` : "blank";
  const close = () => {
    setPicked("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto" data-testid="wa-template-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-emerald-600" />
            {label ? `Create the template for ${label}` : "Create a template"}
          </DialogTitle>
          <DialogDescription>
            Meta reviews every template before it can be sent. Once approved, messages of this kind go out with it.
          </DialogDescription>
        </DialogHeader>
        {!messageType && !draft && types.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2.5">
            <Label htmlFor="wa-tpl-from" className="text-xs">
              Start from
            </Label>
            <select
              id="wa-tpl-from"
              className={cn(SELECT, "h-8 w-auto min-w-56 flex-1 sm:flex-none")}
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              data-testid="wa-tpl-from"
            >
              <option value="">A blank template</option>
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground">
              A message type fills in its HRMS wording and variables, ready to edit.
            </span>
          </div>
        )}
        {type && !draft && fetched.isLoading ? (
          <div className="grid gap-4 md:grid-cols-2" data-testid="wa-template-draft-loading">
            <Skeleton className="h-80 rounded-xl" />
            <Skeleton className="h-80 rounded-xl" />
          </div>
        ) : type && !draft && !fetched.data ? (
          <Notice tone="bad" role="alert" testId="wa-template-draft-error" title="The draft could not be made">
            {whatsAppErrorMessage(fetched.error, "Try again in a moment.")}
          </Notice>
        ) : start ? (
          <EditorForm key={formKey} draft={start} label={typeLabel} onClose={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
