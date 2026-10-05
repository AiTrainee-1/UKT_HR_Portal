// md-admin: the super administrator's controls for the MD portal's AI assistant (Account Management > MD profile).
// The Gemini API key is NOT part of this: it lives in the server's environment and is never sent to the browser.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type MdAssistantSettings = {
  enabled: boolean;
  model: string;
  fallbackModels: string[];
  thinkingLevel: ThinkingLevel;
  privacyMode: boolean;
  maxToolRounds: number;
  requestsPerMinute: number;
  /** Whether GEMINI_API_KEY is set on the server (the key itself is never returned). */
  keyConfigured: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  usage: { requests: number; limitHit: boolean; resetsAt: string; models: { model: string; requests: number }[] };
};

export type MdAssistantSettingsInput = Partial<
  Pick<
    MdAssistantSettings,
    "enabled" | "model" | "fallbackModels" | "thinkingLevel" | "privacyMode" | "maxToolRounds" | "requestsPerMinute"
  >
>;

export type MdAssistantTestResult = {
  ok: boolean;
  kind?: string;
  error?: string;
  model?: string;
  ms?: number;
  reply?: string;
  availableModels?: string[];
};

export const getMdAssistantSettingsQueryKey = () => ["/api/hr-users/md-assistant"] as const;

export const useMdAssistantSettings = () =>
  useQuery<MdAssistantSettings>({
    queryKey: getMdAssistantSettingsQueryKey(),
    queryFn: () => customFetch<MdAssistantSettings>("/api/hr-users/md-assistant"),
  });

export const useUpdateMdAssistantSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: MdAssistantSettingsInput) =>
      customFetch<MdAssistantSettings>("/api/hr-users/md-assistant", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: (saved) => queryClient.setQueryData(getMdAssistantSettingsQueryKey(), saved),
  });
};

/** One tiny request to the configured model (costs one request of the day's allowance). */
export const useTestMdAssistant = () =>
  useMutation({
    mutationFn: () =>
      customFetch<MdAssistantTestResult>("/api/hr-users/md-assistant/test", {
        method: "POST",
        body: JSON.stringify({}),
      }),
  });
