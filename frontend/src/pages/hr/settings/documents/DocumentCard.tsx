import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  getDocumentSettingsQueryKey,
  previewDocumentPdf,
  useDocumentSettings,
  useUpdateDocumentSettings,
  type DocumentSettingsItem,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { DOCUMENTS_SETTINGS } from "../DocumentsTab.meta";
import { ColourField } from "../identity/ColourField";
import { contrastRatio, contrastText, isHexColour } from "../identity/colours";
import {
  documentContactLine,
  footerNote,
  letterheadContactLines,
  letterheadName,
  slipHeader,
  type CompanyValues,
} from "../identity/company-outputs";
import { DocumentSketch, type DocumentSketchProps, type SketchPart } from "../identity/DocumentSketch";
import { errorText } from "../identity/errors";
import { ImageUpload } from "../identity/ImageUpload";
import { logoFitText, useImageSize } from "../identity/images";
import { metaOf } from "../identity/meta";
import { FOOTER_LINES, lineFit, watermarkFits, widthText } from "../identity/pdf-text";
import { SaveFooter } from "../identity/SaveFooter";
import { useDraft } from "../identity/useDraft";
import { pdfRupee } from "../salary-slip/preview";
import { affectsOf, type DocDef } from "./docs";

type Look = Omit<DocumentSettingsItem, "docType" | "updatedAt">;

/** What a document type looks like before HR has saved anything for it (CompanyDocumentSettings defaults). */
export const DEFAULT_LOOK: Look = {
  primaryColor: "#0E4B3A",
  accentColor: "#C9A227",
  headingStyle: "serif",
  showWatermark: true,
  footerTagline: "Weaving Quality. Building Trust.",
  logoOverride: "",
};

const fromData = (d: DocumentSettingsItem | undefined): Look =>
  d
    ? {
        primaryColor: d.primaryColor,
        accentColor: d.accentColor,
        headingStyle: d.headingStyle === "sans" ? "sans" : "serif",
        showWatermark: d.showWatermark,
        footerTagline: d.footerTagline ?? "",
        logoOverride: d.logoOverride ?? "",
      }
    : DEFAULT_LOOK;

const text = (id: string) => metaOf(DOCUMENTS_SETTINGS, id);

/** White text (the footer, table headers) on a colour: readable from about 3 : 1 for this bold or large print. */
function whiteOn(colour: string, where: string) {
  if (!isHexColour(colour)) return null;
  const ratio = contrastRatio(colour, "#ffffff");
  const ok = ratio >= 3;
  return (
    <PreviewLine
      label={`White ${where} on this colour`}
      result={`${contrastText(ratio)} ${ok ? "- readable" : "- hard to read"}`}
      tone={ok ? "good" : "warn"}
    />
  );
}

/**
 * One document type's look: six settings stored in their own row (GET/PUT /api/document-settings/<type>) with their own
 * Save button. Kept mounted while another document is shown, so unsaved edits survive switching; only the shown card
 * carries the blocks' ids (the page's search jumps to those).
 */
export function DocumentCard({
  doc,
  active,
  readOnly,
  settings,
  onDirtyChange,
}: {
  doc: DocDef;
  active: boolean;
  readOnly: boolean;
  settings: PayrollSettingsItem | undefined;
  onDirtyChange: (type: DocDef["type"], dirty: boolean, primary: string) => void;
}) {
  const { toast } = useToast();
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { data } = useDocumentSettings(doc.type);
  const update = useUpdateDocumentSettings(doc.type);
  const [previewing, setPreviewing] = useState(false);

  const saved = useMemo(() => fromData(data), [data]);
  const { form, set, discard, dirty } = useDraft(saved);
  const disabled = readOnly || !data;
  const slip = doc.type === "salary_slip";
  const affects = affectsOf(doc.type);
  const logoSize = useImageSize(form.logoOverride || null);

  useEffect(
    () => onDirtyChange(doc.type, dirty, form.primaryColor),
    [doc.type, dirty, form.primaryColor, onDirtyChange],
  );

  const company: CompanyValues = {
    companyName: settings?.companyName ?? "",
    companyAddress: settings?.companyAddress ?? "",
    companyPhone: settings?.companyPhone ?? "",
    companyEmail: settings?.companyEmail ?? "",
    companyWebsite: settings?.companyWebsite ?? "",
    companyGstin: settings?.companyGstin ?? "",
    companyTagline: settings?.companyTagline ?? "",
  };
  const companyLogo = settings?.companyLogo || null;
  const header = slip
    ? slipHeader(
        { slipCompanyName: settings?.slipCompanyName ?? "", slipCompanyAddress: settings?.slipCompanyAddress ?? "" },
        company.companyName,
      )
    : { name: letterheadName(company.companyName), address: company.companyAddress.trim() };
  const tagline = form.footerTagline.trim();
  const taglineFit = lineFit(tagline, FOOTER_LINES.tagline.font, FOOTER_LINES.tagline.sizePt);
  const watermarkText = letterheadName(company.companyName);

  const problem = !isHexColour(form.primaryColor)
    ? "Fix the theme colour code first."
    : !isHexColour(form.accentColor)
      ? "Fix the accent colour code first."
      : taglineFit.offPaper
        ? "Shorten the footer tagline first: it would run off the page."
        : null;

  const sketch = (extra: Partial<DocumentSketchProps> = {}): DocumentSketchProps => ({
    doc: doc.type,
    label: `${doc.title} drawn with these settings`,
    primary: form.primaryColor,
    accent: form.accentColor,
    headingStyle: form.headingStyle,
    logo: form.logoOverride || companyLogo,
    name: header.name,
    address: header.address,
    contacts: slip ? [] : letterheadContactLines(company),
    watermark: form.showWatermark ? watermarkText : null,
    tagline,
    contactLine: documentContactLine(company),
    note: footerNote(doc.type, company.companyName, "SAMPLE-PREVIEW"),
    signature: slip ? (settings?.signatureImage ?? null) : (settings?.authorizedSignature ?? null),
    minWage: pdfRupee(settings?.minWageRate ?? 0),
    ...extra,
  });
  const cutOut = (part: SketchPart, highlight: SketchPart[], label: string) => (
    <DocumentSketch {...sketch({ crop: part, highlight, width: 340, label })} />
  );
  const id = (metaId: string) => (active ? metaId : undefined);
  const inputId = (name: string) => `${doc.type}-${name}`;

  const save = async () => {
    if (problem) return;
    try {
      const result = await update.mutateAsync({ ...form, footerTagline: tagline });
      queryClient.setQueryData(getDocumentSettingsQueryKey(doc.type), result);
      discard();
      toast({
        title: `${doc.title} settings saved`,
        description: slip
          ? "Every salary slip opened, downloaded or sent from now on uses this look, older months included (the 2-slips-per-page print takes only the two colours). Files already sent do not change."
          : `Every ${doc.title.toLowerCase()} made from now on uses this look. Letters already sent or printed do not change.`,
      });
    } catch (e) {
      toast({ title: "Failed to save", description: errorText(e), variant: "destructive" });
    }
  };

  const openPreview = async () => {
    setPreviewing(true);
    try {
      await previewDocumentPdf(`/api/document-settings/${doc.type}/preview`, () => token);
    } catch (e) {
      toast({ title: "Failed to generate preview", description: errorText(e), variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="space-y-4" hidden={!active} data-testid={`document-card-${doc.type}`}>
      <SettingsSection
        icon={FileSignature}
        title={doc.title}
        purpose={doc.made}
        usedBy={doc.usedBy}
        testId={active ? "document-card-active" : undefined}
      >
        <PreviewCard
          title={`A ${doc.title.toLowerCase()} with this look`}
          scenario={`Drawn from the settings below as they are typed, with the Company and Salary Slip tabs' saved details. The PDF button opens the real ${doc.title.toLowerCase()} for a made-up employee (Priya Sharma, SAMPLE-001), with the saved look.`}
        >
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <DocumentSketch {...sketch({ width: 230 })} />
            <div className="min-w-0 space-y-2" data-view-safe>
              <Button
                size="sm"
                variant="outline"
                onClick={openPreview}
                disabled={previewing || !data}
                className="gap-1.5"
                data-view-safe
                data-testid={`preview-pdf-${doc.type}`}
              >
                <Eye size={13} /> {previewing ? "Generating…" : "Preview saved PDF"}
              </Button>
              <p className={dirty ? "text-xs font-medium text-amber-700" : "text-xs text-gray-500"}>
                {dirty
                  ? "The PDF shows the saved look, not your unsaved changes: save first to see them in it. The drawing here already shows them."
                  : "Opens the real PDF in a new browser tab. Nothing is saved or sent."}
              </p>
            </div>
          </div>
        </PreviewCard>

        <SettingBlock
          {...text("doc-primary")}
          id={id("doc-primary")}
          labelFor={inputId("primary")}
          affects={affects.primary}
          defaultText="#0E4B3A (emerald)"
          note="Each of the four documents keeps its own colours: to make them all alike, set the same code on each. The ID card and the portal theme have colours of their own."
          preview={
            <PreviewCard title="Readability">
              {whiteOn(form.primaryColor, "footer text")}
              {slip && whiteOn(form.primaryColor, '"NET AMOUNT PAID" text')}
            </PreviewCard>
          }
        >
          <ColourField
            id={inputId("primary")}
            value={form.primaryColor}
            onChange={(v) => set("primaryColor", v)}
            noun={`${doc.title} theme colour`}
            disabled={disabled}
            fallback="#0e4b3a"
          />
        </SettingBlock>

        <SettingBlock
          {...text("doc-accent")}
          id={id("doc-accent")}
          labelFor={inputId("accent")}
          affects={affects.accent}
          defaultText="#C9A227 (gold)"
          preview={
            slip ? (
              <PreviewCard title="Readability">{whiteOn(form.accentColor, '"Deductions" header text')}</PreviewCard>
            ) : undefined
          }
        >
          <ColourField
            id={inputId("accent")}
            value={form.accentColor}
            onChange={(v) => set("accentColor", v)}
            noun={`${doc.title} accent colour`}
            disabled={disabled}
            fallback="#c9a227"
          />
        </SettingBlock>

        <SettingBlock
          {...text("doc-heading")}
          id={id("doc-heading")}
          labelFor={inputId("heading")}
          affects={affects.heading}
          defaultText="Serif (elegant)"
          note="Serif prints in Georgia and sans in Arial on a Windows server; a server without those fonts uses Times and Helvetica instead."
          preview={
            <PreviewCard title="Top of the page">
              {cutOut("title", ["name", "title"], `${doc.title} heading`)}
            </PreviewCard>
          }
        >
          <select
            id={inputId("heading")}
            value={form.headingStyle}
            disabled={disabled}
            onChange={(e) => set("headingStyle", e.target.value === "sans" ? "sans" : "serif")}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="serif">Serif (elegant)</option>
            <option value="sans">Sans (modern)</option>
          </select>
        </SettingBlock>

        <SettingBlock
          {...text("doc-tagline")}
          id={id("doc-tagline")}
          labelFor={inputId("tagline")}
          affects={affects.tagline}
          defaultText="Weaving Quality. Building Trust."
          note="It is printed on one line and never wrapped. Up to the page border it fits; past the paper's edge both ends are cut off, so such a tagline cannot be saved. The Company tab's Tagline is a different setting that only Excel exports print."
          preview={
            <PreviewCard title="Footer of every page">
              {cutOut("tagline", ["tagline"], `${doc.title} footer`)}
              <PreviewLine
                label={tagline ? "Tagline width" : "No tagline"}
                result={
                  !tagline
                    ? "the line is left out"
                    : taglineFit.fits
                      ? `fits (${widthText(taglineFit)})`
                      : taglineFit.offPaper
                        ? `runs off the page: about ${taglineFit.charsOver} characters too many`
                        : `reaches the paper edge: about ${taglineFit.charsOver} characters past the border`
                }
                tone={!tagline ? "neutral" : taglineFit.fits ? "good" : taglineFit.offPaper ? "bad" : "warn"}
                testId={`tagline-fit-${doc.type}`}
              />
            </PreviewCard>
          }
        >
          <Input
            id={inputId("tagline")}
            value={form.footerTagline}
            disabled={disabled}
            maxLength={160}
            placeholder="Weaving Quality. Building Trust."
            onChange={(e) => set("footerTagline", e.target.value)}
            data-testid={`input-tagline-${doc.type}`}
          />
        </SettingBlock>

        <SettingBlock
          {...text("doc-logo")}
          id={id("doc-logo")}
          affects={affects.logo}
          defaultText="None: the Company tab's logo is used"
          note="Drawn in the same fixed 2.6 cm x 1.5 cm box as the company logo. A file the server cannot read prints no logo at all (it does not fall back to the company logo)."
          preview={
            <PreviewCard title="Top of the page">
              {cutOut("logo", ["logo"], `${doc.title} logo`)}
              <PreviewLine
                label={form.logoOverride ? "This document's own logo" : "No logo of its own"}
                result={
                  form.logoOverride
                    ? logoSize
                      ? logoFitText(logoSize.width, logoSize.height).text
                      : "loading"
                    : companyLogo
                      ? "prints the Company tab's logo"
                      : "prints no logo (none on the Company tab either)"
                }
                tone={form.logoOverride && logoSize ? logoFitText(logoSize.width, logoSize.height).tone : "neutral"}
              />
            </PreviewCard>
          }
        >
          <ImageUpload
            id={inputId("logo-file")}
            value={form.logoOverride || null}
            onChange={(v) => set("logoOverride", v ?? "")}
            noun="logo override"
            disabled={disabled}
          />
        </SettingBlock>

        <SettingBlock
          {...text("doc-watermark")}
          id={id("doc-watermark")}
          affects={affects.watermark}
          defaultText="On"
          note="A faint watermark can darken photocopies."
          preview={
            <PreviewCard title="Behind the text">
              <PreviewLine
                label={form.showWatermark ? `Prints "${watermarkText}"` : "No watermark"}
                result={
                  !form.showWatermark
                    ? "clean pages"
                    : watermarkFits(company.companyName)
                      ? "fits across the page"
                      : "too long: both ends are cut off the page"
                }
                tone={!form.showWatermark || watermarkFits(company.companyName) ? "neutral" : "warn"}
              />
            </PreviewCard>
          }
        >
          <ToggleField
            id={inputId("watermark")}
            checked={form.showWatermark}
            onChange={(v) => set("showWatermark", v)}
            onLabel="Watermark on every page"
            offLabel="No watermark"
            disabled={disabled}
          />
        </SettingBlock>
      </SettingsSection>

      {active && (
        <SaveFooter
          dirty={dirty}
          saving={update.isPending}
          onSave={save}
          onDiscard={discard}
          saveLabel={`Save ${doc.title} Settings`}
          disabled={disabled || !dirty || Boolean(problem)}
          hint={
            !data
              ? "Loading the saved look…"
              : problem
                ? problem
                : dirty
                  ? `You have changes to the ${doc.title.toLowerCase()} that are not saved yet.`
                  : undefined
          }
        />
      )}
    </div>
  );
}
