import { getApiOrigin } from "@/lib/api-client/custom-fetch";
import { InvalidTemplateError, type BulkResult, type Category, type ListStatus, type RemovalAction } from "./types";

type CommonOptions = { category: Category; mode: "preview" | "apply" };

export type UpdateOptions = CommonOptions & {
  status: ListStatus;
  missingAction?: RemovalAction;
  missingDecisions?: Record<string, RemovalAction>;
  confirmDelete?: boolean;
};

async function post(path: string, file: File, fields: Record<string, string>): Promise<BulkResult> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("uk_textile_token")}` },
      body: form,
    });
  } catch {
    throw new Error(
      "The server could not be reached, or it stopped answering. A file that is checked is never saved, and an upload " +
        "is saved completely or not at all: look at the employee list, and if nothing changed, try again or split " +
        "the file into smaller parts.",
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error === "invalid_template") throw new InvalidTemplateError(body.message);
    if (!body.message && !body.error && [502, 503, 504].includes(response.status)) {
      throw new Error(
        `The server did not answer in time (HTTP ${response.status}). Nothing was saved. The file may be too big to ` +
          "process at once: split it into smaller parts and upload them one at a time.",
      );
    }
    throw new Error(body.message || body.error || "The upload failed");
  }
  return body as BulkResult;
}

/** Add new employees (or just check the file: `mode: "preview"` writes nothing). */
export const uploadNewEmployees = (file: File, o: CommonOptions) =>
  post("/api/employees/bulk-upload", file, { category: o.category, mode: o.mode });

/** Update the existing employees of one kind and state from an edited download. */
export const uploadEmployeeUpdates = (file: File, o: UpdateOptions) =>
  post("/api/employees/bulk-update", file, {
    category: o.category,
    employeeStatus: o.status,
    mode: o.mode,
    ...(o.missingAction ? { missingAction: o.missingAction } : {}),
    ...(o.missingDecisions && Object.keys(o.missingDecisions).length
      ? { missingDecisions: JSON.stringify(o.missingDecisions) }
      : {}),
    ...(o.confirmDelete ? { confirmDelete: "true" } : {}),
  });
