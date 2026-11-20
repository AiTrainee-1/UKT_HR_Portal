import { useRef } from "react";
import { Link, useRoute } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { CustomReportBuilder, CUSTOMISE_CATALOG_HREF } from "./CustomReportBuilder";
import { CUSTOMISE_PATH } from "./builder-logic";

/**
 * The report builder's page: /hr/reports/customise/new (a new report) and /hr/reports/customise/<id>/edit (a saved one).
 * HR portal only (the MD portal lists saved reports read-only in its library). Gated by Reports -> Customise
 * (permission_tree: view may preview, edit may save).
 */
export default function CustomReportBuilderPage() {
  const [isEdit, params] = useRoute<{ id: string }>(`${CUSTOMISE_PATH}/:id/edit`);
  const id = isEdit ? Number(params.id) : null;
  const valid = id === null || (Number.isInteger(id) && id > 0);
  // A new report moves to its own address once saved: that is still the same builder (what was on screen stays).
  // Any other change of address (another saved report, a new one) starts a fresh builder.
  const created = useRef<number | null>(null);
  const key = id === null || id === created.current ? "new" : `saved-${id}`;

  return (
    <HrLayout>
      {valid ? (
        // Trying fields and filters only changes this page, never data, so a View-only role keeps those buttons (the
        // page-wide lock would take "Remove" / "Add all" too); Save is shown only to Edit, and the server checks it.
        <div {...{ [VIEW_SAFE_ATTR]: "" }}>
          <CustomReportBuilder
            key={key}
            editId={id}
            onCreated={(newId) => {
              created.current = newId;
            }}
          />
        </div>
      ) : (
        <Card className="border-0 shadow-sm">
          <CardContent className="space-y-3 p-8 text-center">
            <p className="text-base font-semibold text-gray-800">This custom report does not exist</p>
            <Link
              href={CUSTOMISE_CATALOG_HREF}
              className="inline-block text-sm font-semibold text-sky-700 hover:underline"
            >
              Back to the saved reports
            </Link>
          </CardContent>
        </Card>
      )}
    </HrLayout>
  );
}
