import { useMemo, type ComponentProps } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, FileSpreadsheet, Info, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getPayrollSettingsQueryKey,
  useDocumentSettings,
  useIdCardSettings,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { COMPANY_SETTINGS } from "./CompanyTab.meta";
import { BranchNote } from "./identity/BranchNote";
import {
  documentContactLine,
  emailCompanyName,
  footerNote,
  idCardCompany,
  letterSentenceName,
  letterheadContactLines,
  letterheadName,
  reportLetterhead,
  sidebarName,
  type CompanyValues,
} from "./identity/company-outputs";
import { DocumentSketch } from "./identity/DocumentSketch";
import { errorText } from "./identity/errors";
import { ImageUpload } from "./identity/ImageUpload";
import { logoFitText, useImageSize } from "./identity/images";
import { metaOf } from "./identity/meta";
import { FOOTER_LINES, lineFit, watermarkFits, widthText, type LineFit } from "./identity/pdf-text";
import { SaveFooter } from "./identity/SaveFooter";
import { useDraft } from "./identity/useDraft";
import { IdCardHeaderSketch, ReportHeaderSketch, SidebarSketch } from "./company/CompanySketches";

type CompanyForm = CompanyValues & { companyLogo: string | null };

const EMPTY: CompanyForm = {
  companyLogo: null,
  companyName: "",
  companyAddress: "",
  companyPhone: "",
  companyEmail: "",
  companyWebsite: "",
  companyGstin: "",
  companyTagline: "",
};

type TextKey = Exclude<keyof CompanyForm, "companyLogo">;

const EMAIL = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;
// 2-digit state code, the 10-character PAN, entity number, "Z", check character.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const fromSettings = (s: PayrollSettingsItem | undefined): CompanyForm =>
  s
    ? {
        companyLogo: s.companyLogo || null,
        companyName: s.companyName ?? "",
        companyAddress: s.companyAddress ?? "",
        companyPhone: s.companyPhone ?? "",
        companyEmail: s.companyEmail ?? "",
        companyWebsite: s.companyWebsite ?? "",
        companyGstin: s.companyGstin ?? "",
        companyTagline: s.companyTagline ?? "",
      }
    : EMPTY;

const text = (id: string) => metaOf(COMPANY_SETTINGS, id);

function fitLine(label: string, line: string, fit: LineFit, testId?: string) {
  return (
    <PreviewLine
      label={
        <span>
          {label}: <span className="font-normal">{line || "(nothing printed)"}</span>
        </span>
      }
      result={fit.fits ? `fits (${widthText(fit)})` : fit.offPaper ? "runs off the page" : "reaches the paper edge"}
      tone={fit.fits ? "good" : fit.offPaper ? "bad" : "warn"}
      testId={testId}
    />
  );
}

export default function CompanyTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const update = useUpdatePayrollSettings();
  // The offer letter's saved look and the ID card colours, only to draw the examples with the real colours.
  const { data: offerLook } = useDocumentSettings("offer_letter");
  const { data: card } = useIdCardSettings();

  const saved = useMemo(() => fromSettings(settings), [settings]);
  const { form, set, discard, dirty } = useDraft(saved);
  const logoSize = useImageSize(form.companyLogo);

  const branchLogin = settings?.companyWideRulesEditable === false;
  const disabled = readOnly || !settings;
  const slip = {
    slipCompanyName: settings?.slipCompanyName ?? "",
    slipCompanyAddress: settings?.slipCompanyAddress ?? "",
  };

  const emailProblem =
    form.companyEmail.trim() && !EMAIL.test(form.companyEmail.trim())
      ? "Type one email address, such as hr@yourcompany.in (it is printed exactly as typed)."
      : null;
  const gstinLooksOdd = form.companyGstin.trim() !== "" && !GSTIN.test(form.companyGstin.trim().toUpperCase());

  const contactLine = documentContactLine(form);
  const contactFit = lineFit(contactLine, FOOTER_LINES.contact.font, FOOTER_LINES.contact.sizePt);
  const note = footerNote("offer_letter", form.companyName);
  const noteFit = lineFit(note, FOOTER_LINES.note.font, FOOTER_LINES.note.sizePt);
  const cardCompany = idCardCompany(form, slip);
  const report = reportLetterhead(form);
  const logoFit = logoSize ? logoFitText(logoSize.width, logoSize.height) : null;

  const save = async () => {
    if (!settings || emailProblem) return;
    try {
      const body: Partial<PayrollSettingsItem> = {
        companyName: form.companyName.trim(),
        companyAddress: form.companyAddress.trim(),
        companyPhone: form.companyPhone.trim(),
        companyEmail: form.companyEmail.trim(),
        companyWebsite: form.companyWebsite.trim(),
        companyGstin: form.companyGstin.trim(),
        companyTagline: form.companyTagline.trim(),
        // null is meaningful: it removes a saved logo.
        companyLogo: form.companyLogo,
        // No longer on the page (nothing reads them), but the save has always carried them: send what is stored.
        companyPan: settings.companyPan,
        companyRegistration: settings.companyRegistration,
      };
      const result = await update.mutateAsync(body);
      queryClient.setQueryData(getPayrollSettingsQueryKey(), result);
      discard();
      toast({
        title: "Company settings saved",
        description: branchLogin
          ? "Saved as your branch's own copy: your branch's sidebar, ID Cards page and emails use it. Letters, salary slip PDFs and report headers keep the company's values."
          : "Letters, salary slips, ID cards, emails and report headers made from now on use these details (a fresh download of an older slip too). Files already sent or printed do not change.",
      });
    } catch (e) {
      toast({ title: "Couldn't save the company settings", description: errorText(e), variant: "destructive" });
    }
  };

  const field = (key: TextKey, id: string, props: ComponentProps<typeof Input> = {}) => (
    <Input
      id={id}
      value={form[key]}
      disabled={disabled}
      onChange={(e) => set(key, e.target.value)}
      data-testid={`input-${key}`}
      {...props}
    />
  );

  return (
    <div className="space-y-4">
      {branchLogin && <BranchNote what="Company details" />}

      <SettingsSection
        icon={Building2}
        title="Company Profile"
        purpose="Who the company is, on screen and on paper. The name and logo head the portal's sidebar and every letter, salary slip, ID card and report the portal prints."
        usedBy={[
          { label: "Sidebar" },
          { label: "Letters and salary slips", to: "/hr/recruitment/documents" },
          { label: "ID cards", to: "/hr/id-cards" },
          { label: "Report Center", to: "/hr/reports" },
          { label: "Emails", to: "/hr/gmail-control" },
        ]}
        testId="company-profile"
      >
        <PreviewCard
          title="Where these details appear"
          scenario="Drawn from what is typed below, before it is saved: an offer letter page (with the look saved for offer letters on the Company Documents tab), the sidebar, the top of an ID card and the first rows of an exported report."
          testId="company-overview"
        >
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <DocumentSketch
              doc="offer_letter"
              label="Offer letter page drawn with these details"
              width={230}
              primary={offerLook?.primaryColor ?? "#0E4B3A"}
              accent={offerLook?.accentColor ?? "#C9A227"}
              headingStyle={offerLook?.headingStyle ?? "serif"}
              logo={offerLook?.logoOverride || form.companyLogo}
              name={letterheadName(form.companyName)}
              address={form.companyAddress.trim()}
              contacts={letterheadContactLines(form)}
              watermark={(offerLook?.showWatermark ?? true) ? letterheadName(form.companyName) : null}
              tagline={offerLook?.footerTagline ?? "Weaving Quality. Building Trust."}
              contactLine={contactLine}
              note={note}
              signature={settings?.authorizedSignature ?? null}
            />
            <div className="min-w-0 space-y-2.5">
              <SidebarSketch name={sidebarName(form.companyName)} logo={form.companyLogo} />
              <IdCardHeaderSketch
                name={cardCompany.name}
                address={cardCompany.address}
                logo={form.companyLogo}
                primary={card?.primaryColor ?? "#006496"}
                secondary={card?.secondaryColor ?? "#4FB8F0"}
              />
              <ReportHeaderSketch name={report.name} subLine={report.excelSubLine} logo={form.companyLogo} excel />
              <PreviewLine
                label="Salary slip email subject"
                result={`Salary Slip - July 2026 | ${emailCompanyName(form.companyName, slip.slipCompanyName)}`}
              />
            </div>
          </div>
        </PreviewCard>

        <SettingBlock
          {...text("company-logo")}
          affects={[
            { where: "Sidebar", what: "a small round badge beside the company name (HR and MD portals)" },
            {
              where: "Offer, experience and resignation letters",
              what: "top-left of the letterhead, unless that document has its own logo on the Company Documents tab",
              to: "/hr/settings?tab=documents",
            },
            {
              where: "Salary slip PDF",
              what: "top-left of the slip header (the same Company Documents override applies); the 2-slips-per-page print has no logo",
            },
            {
              where: "ID cards",
              what: "the card's top band on the ID Cards page and in the Employee Mobile App",
              to: "/hr/id-cards",
            },
            {
              where: "Report Center and attendance exports",
              what: "the letterhead of Excel and PDF exports",
              to: "/hr/reports",
            },
            { where: "QR verification page", what: "the public page a scanned ID card opens" },
          ]}
          defaultText="No logo"
          note="Letters and slips fit the logo into a fixed 2.6 cm x 1.5 cm box without keeping its shape, so a square logo prints squashed; a logo about 1.7 times wider than tall prints true. Not used on the sign-in pages, in the employee apps' menus, in emails or on the e-mailed ID card picture."
          preview={
            <PreviewCard title="How it prints" scenario="The logo above, in the boxes the portal draws it in.">
              {form.companyLogo ? (
                <>
                  <div className="flex flex-wrap items-end gap-4">
                    <figure className="space-y-1">
                      <img
                        src={form.companyLogo}
                        alt="Logo as a letter prints it"
                        className="h-[60px] w-[104px] rounded border border-dashed border-slate-300 bg-white object-fill"
                      />
                      <figcaption className="text-[10px] text-gray-500">Letter / slip box</figcaption>
                    </figure>
                    <figure className="space-y-1">
                      <img
                        src={form.companyLogo}
                        alt="Logo as the sidebar shows it"
                        className="h-9 w-9 rounded-full bg-white object-contain ring-1 ring-slate-200"
                      />
                      <figcaption className="text-[10px] text-gray-500">Sidebar</figcaption>
                    </figure>
                    <figure className="space-y-1">
                      <img
                        src={form.companyLogo}
                        alt="Logo as a report header shows it"
                        className="h-11 w-11 bg-white object-contain ring-1 ring-slate-200"
                      />
                      <figcaption className="text-[10px] text-gray-500">Report header</figcaption>
                    </figure>
                  </div>
                  {logoSize && logoFit && (
                    <PreviewLine
                      label={`This logo is ${logoSize.width} x ${logoSize.height} px`}
                      result={logoFit.text}
                      tone={logoFit.tone}
                      testId="logo-fit"
                    />
                  )}
                </>
              ) : (
                <PreviewLine label="No logo" result="letters, slips and reports print the name alone" tone="info" />
              )}
            </PreviewCard>
          }
        >
          <ImageUpload
            id="company-logo-file"
            value={form.companyLogo}
            onChange={(v) => set("companyLogo", v)}
            noun="logo"
            disabled={disabled}
          />
          <p className="text-xs text-gray-500">
            Any picture file; it is shrunk to at most 600 x 600 pixels before it is saved. Removing it takes effect when
            you save.
          </p>
        </SettingBlock>

        <SettingBlock
          {...text("company-name")}
          labelFor="company-name-input"
          affects={[
            { where: "Sidebar", what: "the title at the top of the HR and MD portal menus" },
            {
              where: "Letters",
              what: 'the letterhead in capitals, sentences such as "We are pleased to offer you employment with ..." and the small print at the foot of each page',
              to: "/hr/recruitment/documents",
            },
            {
              where: "Watermark",
              what: "the faint diagonal name on every letter and salary slip page, when the watermark is on",
            },
            {
              where: "Salary slip PDF",
              what: "the page footer and watermark; the slip header prints the Salary Slip tab's name (this one only when that is blank)",
              to: "/hr/settings?tab=salary-slip",
            },
            {
              where: "Emails",
              what: "the company name in the subject, heading and sign-off of every email the portal sends",
              to: "/hr/gmail-control",
            },
            {
              where: "ID cards",
              what: 'the card\'s top band, the "If found, please return to ..." line and the e-mailed card picture',
              to: "/hr/id-cards",
            },
            {
              where: "Report Center and attendance exports",
              what: 'the letterhead and "Generated by ... HRMS"',
              to: "/hr/reports",
            },
            { where: "MD portal assistant", what: "how the Managing Director's assistant names the company" },
          ]}
          defaultText="UKTextiles"
          note="Left blank, each place falls back to its own default, so they disagree: the sidebar shows UKTextiles, letters print UK TEXTILES and emails use the Salary Slip tab's name."
          preview={
            <PreviewCard title="Where the name appears" scenario="The name typed above, as each place prints it.">
              <PreviewLine label="Sidebar title" result={sidebarName(form.companyName)} />
              <PreviewLine label="Letterhead" result={letterheadName(form.companyName)} />
              <PreviewLine
                label="Offer letter"
                result={`We are pleased to offer you employment with ${letterSentenceName(form.companyName)}.`}
              />
              <PreviewLine
                label="Salary slip email subject"
                result={`Salary Slip - July 2026 | ${emailCompanyName(form.companyName, slip.slipCompanyName)}`}
              />
              <PreviewLine
                label="Diagonal watermark (66 pt)"
                result={
                  watermarkFits(form.companyName) ? "fits across the page" : "too long: both ends are cut off the page"
                }
                tone={watermarkFits(form.companyName) ? "good" : "warn"}
                testId="watermark-fit"
              />
              {fitLine("Offer letter small print", note, noteFit)}
            </PreviewCard>
          }
        >
          {field("companyName", "company-name-input", { placeholder: "UKTextiles", maxLength: 120 })}
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={MapPin}
        title="Address and contact details"
        purpose="Printed on the letterhead and in the coloured footer of every letter and salary slip page, and on report headers. They are not the address emails are sent from, nor the numbers employees are told to call for help."
        usedBy={[
          { label: "Letters and salary slips", to: "/hr/recruitment/documents" },
          { label: "ID cards", to: "/hr/id-cards" },
          { label: "Report Center", to: "/hr/reports" },
        ]}
        testId="company-contact"
      >
        <SettingBlock
          {...text("company-address")}
          labelFor="company-address-input"
          affects={[
            {
              where: "Letters",
              what: "the line under the company name, and the first item of the footer contact line on every page",
            },
            {
              where: "Salary slip PDF",
              what: "the first item of the footer contact line (the slip header prints the Salary Slip tab's address)",
            },
            {
              where: "ID cards",
              what: "the small line in the card's top band and \"If found, please return to ...\" on the back (the Salary Slip tab's address when this is blank)",
              to: "/hr/id-cards",
            },
            { where: "Report Center and attendance exports", what: "the letterhead's second line", to: "/hr/reports" },
            {
              where: "Interview invitation email",
              what: 'the "Location:" line candidates are sent',
              to: "/hr/recruitment/resume-screening",
            },
          ]}
          defaultText="Blank"
          preview={
            <PreviewCard
              title="Where the address prints"
              scenario="The address typed above, with the phone, email and website below it."
            >
              {fitLine("Footer contact line", contactLine, contactFit, "contact-line-fit")}
              <PreviewLine
                label="ID card back"
                result={`If found, please return to ${cardCompany.name}, ${cardCompany.address}.`}
              />
              <PreviewLine label="Interview invitation email" result={`Location: ${form.companyAddress.trim()}`} />
            </PreviewCard>
          }
          note={
            contactFit.fits
              ? undefined
              : `The footer contact line is printed on one line and is not wrapped: at ${Math.round(contactFit.widthPt)} pt it is about ${contactFit.charsOver} characters too long for the page. Shorten the address (or leave a part out) to keep it on the paper.`
          }
        >
          {field("companyAddress", "company-address-input", {
            placeholder: "12, Kumaran Road, Tirupur - 641601",
            maxLength: 250,
          })}
        </SettingBlock>

        <SettingBlock
          {...text("company-phone")}
          labelFor="company-phone-input"
          affects={[
            { where: "Letters", what: "the third line of the letterhead's right-hand column" },
            { where: "Letters and salary slip PDF", what: "the footer contact line of every page" },
            { where: "Report Center and attendance exports", what: "the letterhead's second line", to: "/hr/reports" },
          ]}
          defaultText="Blank"
          note="This is not the number employees are told to call for help (that is on the HR Contact tab). It is not printed on ID cards or in emails."
          preview={
            <PreviewCard title="Where the phone prints">
              <PreviewLine
                label="Letterhead, right-hand column"
                result={letterheadContactLines(form).join(" / ") || "(empty)"}
              />
              {fitLine("Footer contact line", contactLine, contactFit)}
            </PreviewCard>
          }
        >
          {field("companyPhone", "company-phone-input", { placeholder: "0421 2234500", maxLength: 60, type: "tel" })}
        </SettingBlock>

        <SettingBlock
          {...text("company-email")}
          labelFor="company-email-input"
          affects={[
            { where: "Letters", what: "the second line of the letterhead's right-hand column" },
            { where: "Letters and salary slip PDF", what: "the footer contact line of every page" },
            { where: "Report Center and attendance exports", what: "the letterhead's second line", to: "/hr/reports" },
          ]}
          defaultText="Blank"
          note="Printed only, nothing is sent to it. Emails are sent from the address on the SMTP / Email tab, and employees write to the address on the HR Contact tab."
          preview={
            <PreviewCard title="Where the email prints">
              <PreviewLine
                label="Letterhead, right-hand column"
                result={letterheadContactLines(form).join(" / ") || "(empty)"}
              />
              {fitLine("Footer contact line", contactLine, contactFit)}
            </PreviewCard>
          }
        >
          {field("companyEmail", "company-email-input", {
            placeholder: "hr@uktextiles.in",
            maxLength: 120,
            type: "email",
            "aria-invalid": emailProblem ? true : undefined,
          })}
          {emailProblem && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {emailProblem}
            </p>
          )}
        </SettingBlock>

        <SettingBlock
          {...text("company-website")}
          labelFor="company-website-input"
          affects={[
            { where: "Letters", what: "the first line of the letterhead's right-hand column" },
            { where: "Letters and salary slip PDF", what: "the footer contact line of every page" },
            { where: "Report Center and attendance exports", what: "the letterhead's second line", to: "/hr/reports" },
          ]}
          defaultText="Blank"
          preview={
            <PreviewCard title="Where the website prints">
              <PreviewLine
                label="Letterhead, right-hand column"
                result={letterheadContactLines(form).join(" / ") || "(empty)"}
              />
              {fitLine("Footer contact line", contactLine, contactFit)}
            </PreviewCard>
          }
        >
          {field("companyWebsite", "company-website-input", { placeholder: "www.uktextiles.in", maxLength: 120 })}
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={FileSpreadsheet}
        title="Only on exported reports"
        purpose="Two details that appear on nothing but the header of reports exported from the Report Center and the attendance pages."
        usedBy={[{ label: "Report Center", to: "/hr/reports" }]}
        testId="company-reports"
      >
        <SettingBlock
          {...text("company-gstin")}
          labelFor="company-gstin-input"
          affects={[
            {
              where: "Report Center and attendance exports",
              what: 'added as "GSTIN <number>" to the letterhead\'s second line, in Excel and PDF',
              to: "/hr/reports",
            },
          ]}
          defaultText="Blank"
          note="Not printed on letters, salary slips, ID cards or emails."
          preview={
            <PreviewCard title="Report header" scenario="The second line of an exported report's letterhead.">
              <ReportHeaderSketch name={report.name} subLine={report.pdfSubLine} logo={form.companyLogo} />
              {gstinLooksOdd && (
                <PreviewLine
                  label="This does not look like a GSTIN"
                  result="15 characters, such as 33AAAAA0000A1Z5"
                  tone="warn"
                  testId="gstin-format"
                />
              )}
            </PreviewCard>
          }
        >
          {field("companyGstin", "company-gstin-input", { placeholder: "33AAAAA0000A1Z5", maxLength: 20 })}
        </SettingBlock>

        <SettingBlock
          {...text("company-tagline")}
          labelFor="company-tagline-input"
          affects={[
            {
              where: "Excel exports from the Report Center",
              what: "the letterhead's second line, only when the address, phone, email, website and GSTIN are all blank",
              to: "/hr/reports",
            },
          ]}
          defaultText="Garments Manufacturing Excellence"
          note={
            <span>
              The slogan in the coloured footer of letters and salary slips is a different setting: each document's
              Footer Tagline on the Company Documents tab.
            </span>
          }
          preview={
            <PreviewCard title="Excel report, second line">
              <PreviewLine
                label={report.pdfSubLine ? "Shows the address and contact details" : "Shows the tagline"}
                result={report.excelSubLine || "(empty)"}
                tone={report.pdfSubLine ? "neutral" : "info"}
                testId="tagline-used"
              />
            </PreviewCard>
          }
        >
          {field("companyTagline", "company-tagline-input", {
            placeholder: "Garments Manufacturing Excellence",
            maxLength: 160,
          })}
        </SettingBlock>

        {settings && (
          <div
            className="mt-2 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[12px] leading-snug text-gray-600"
            data-testid="company-retired-fields"
          >
            <Info size={14} className="mt-0.5 shrink-0 text-gray-400" />
            <span>
              <b>No longer shown: PAN and Registration Details.</b> Nothing in the portal, the Employee Mobile App or
              the Employee Web App printed or used them. What was saved is kept as it was
              {settings?.companyPan ? ` (PAN ${settings.companyPan})` : ""}
              {settings?.companyRegistration ? ` (registration ${settings.companyRegistration})` : ""}.
            </span>
          </div>
        )}
      </SettingsSection>

      <div className="grid gap-3 md:grid-cols-2" data-testid="company-related">
        <ManagedElsewhere
          title="Name and address on the salary slip header"
          to="/hr/settings?tab=salary-slip"
          linkLabel="Salary Slip tab"
        >
          The top of every salary slip prints the Salary Slip tab's own name and address
          {settings?.slipCompanyName ? ` (now "${settings.slipCompanyName}")` : ""}; this tab's name is used there only
          when that one is blank.
        </ManagedElsewhere>
        <ManagedElsewhere
          title="Slogan in letter footers"
          to="/hr/settings?tab=documents"
          linkLabel="Company Documents"
        >
          The line in the coloured footer of letters and slips is set per document as its Footer Tagline.
        </ManagedElsewhere>
        <ManagedElsewhere
          title="Who employees should call for help"
          to="/hr/settings?tab=hr_contact"
          linkLabel="HR Contact tab"
        >
          The phone, WhatsApp and email shown to employees on sign-in and help screens are kept separately.
        </ManagedElsewhere>
        <ManagedElsewhere title="The address emails come from" to="/hr/settings?tab=smtp" linkLabel="SMTP / Email tab">
          The sender name and address of every email the portal sends.
        </ManagedElsewhere>
      </div>

      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={save}
        onDiscard={discard}
        saveLabel="Save Company Settings"
        disabled={disabled || !dirty || Boolean(emailProblem)}
        hint={
          !settings
            ? "Loading the saved details…"
            : emailProblem
              ? "Fix the email address first."
              : dirty
                ? "You have changes that are not saved yet. Nothing changes anywhere until you save."
                : undefined
        }
      />
    </div>
  );
}
