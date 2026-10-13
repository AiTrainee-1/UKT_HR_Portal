import { useCallback, useState } from "react";
import { Files } from "lucide-react";
import { usePayrollSettings, type DocumentType } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ManagedElsewhere, SettingsSection } from "./kit/SettingBlock";
import { isHexColour } from "./identity/colours";
import { DOCS } from "./documents/docs";
import { DEFAULT_LOOK, DocumentCard } from "./documents/DocumentCard";

type CardStatus = { dirty: boolean; primary: string };

export default function DocumentsTab({ readOnly = false }: { readOnly?: boolean }) {
  const { data: settings } = usePayrollSettings();
  const [selected, setSelected] = useState<DocumentType>("offer_letter");
  const [status, setStatus] = useState<Partial<Record<DocumentType, CardStatus>>>({});

  const onDirtyChange = useCallback((type: DocumentType, dirty: boolean, primary: string) => {
    setStatus((s) =>
      s[type]?.dirty === dirty && s[type]?.primary === primary ? s : { ...s, [type]: { dirty, primary } },
    );
  }, []);

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Files}
        title="How company documents look"
        purpose="Each of the four documents keeps its own look: two colours, a heading font, a footer slogan, a watermark and, if wanted, a logo of its own. Pick a document to style it; each one has its own Save."
        usedBy={[
          { label: "Recruitment Documents", to: "/hr/recruitment/documents" },
          { label: "Employees", to: "/hr/employees" },
          { label: "Payroll slips", to: "/hr/payroll" },
        ]}
      >
        <div
          role="radiogroup"
          aria-label="Document to style"
          className="grid grid-cols-2 gap-2 lg:grid-cols-4"
          data-testid="document-picker"
        >
          {DOCS.map((d) => {
            const on = d.type === selected;
            const s = status[d.type];
            const colour = s && isHexColour(s.primary) ? s.primary : DEFAULT_LOOK.primaryColor;
            return (
              <button
                key={d.type}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setSelected(d.type)}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] font-semibold transition-colors",
                  on
                    ? "border-blue-300 bg-blue-50 text-blue-900 ring-1 ring-blue-200"
                    : "border-slate-200 bg-white text-gray-700 hover:bg-slate-50",
                )}
                data-testid={`document-pick-${d.type}`}
              >
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/10"
                  style={{ background: colour }}
                />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {s?.dirty && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                    unsaved
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <ManagedElsewhere
            title="Name, address, contacts and logo"
            to="/hr/settings?tab=company"
            linkLabel="Company tab"
          >
            Every document prints the Company tab's name, address, phone, email and website, and its logo unless the
            document has a logo of its own here.
          </ManagedElsewhere>
          <ManagedElsewhere
            title="Slip header, signatures, minimum wage"
            to="/hr/settings?tab=salary-slip"
            linkLabel="Salary Slip tab"
          >
            The name and address at the top of salary slips, the employer signature on slips and the authorised
            signature on letters are kept on the Salary Slip tab.
          </ManagedElsewhere>
        </div>
      </SettingsSection>

      {DOCS.map((d) => (
        <DocumentCard
          key={d.type}
          doc={d}
          active={d.type === selected}
          readOnly={readOnly}
          settings={settings}
          onDirtyChange={onDirtyChange}
        />
      ))}
    </div>
  );
}
