import type { SharedCatalog, SharedDataset, SharedEndpoint, SharedLimits } from "@/lib/api-client/custom-hooks";
import type { EndpointDraft } from "./form";

/** What every section of the endpoint editor needs: the form, how to change it and what is wrong with it. */
export type SectionProps = {
  draft: EndpointDraft;
  patch: (change: Partial<EndpointDraft>) => void;
  /** Every control is disabled (a view-only login; the tab itself is for the super admin, who is never view-only). */
  readOnly: boolean;
  /** One sentence per box that is wrong, see validateDraft. */
  errors: Record<string, string>;
  /** True while the endpoint is not created yet: its address and dataset can still be chosen. */
  creating: boolean;
  /** The endpoint as saved (null while creating). */
  saved: SharedEndpoint | null;
  savedEnabled: boolean;
  catalog: SharedCatalog;
  dataset: SharedDataset | undefined;
  limits: SharedLimits;
  /** Where the API lives (https://hr.example.com): the front of the address a developer calls. */
  origin: string;
  /** True when what is on screen differs from what is saved. */
  dirty: boolean;
};
