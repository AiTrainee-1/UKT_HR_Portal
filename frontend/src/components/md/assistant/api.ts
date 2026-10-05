// The assistant's API (backend: api/md_portal/assistant/views.py) and the shapes of what it returns.

import { ApiError, customFetch } from "@/lib/api-client/custom-fetch";

export type AssistantStatus = {
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  model: string;
  privacyMode: boolean;
  usage: { requests: number; limitHit: boolean; resetsAt: string };
  voice: { serverTranscription: boolean };
  limits: { questionChars: number };
};

export type StepDto = {
  tool: string;
  title: string;
  summary: string;
  ok: boolean;
  error: string | null;
  ms: number;
  rows: number | null;
  period: string | null;
  scope: string | null;
  args: Record<string, unknown>;
  /** For a free-form data query: the query in words. */
  detail?: string | null;
};

export type DataUsedDto = {
  title: string | null;
  dataset: string | null;
  definition: string | null;
  formula: string | null;
  rows: number | null;
  filters: string[];
  caveats: string[];
  period: string | null;
  scope: string | null;
  from: string;
};

export type SuggestedPage = { id: string; title: string; path: string; reason: string };

export type Confidence = "high" | "medium" | "low";

export type ProgressLine = { label: string; state: "running" | "done" | "error" };

export type HeardPayload = { language?: string; engine?: "browser" | "server"; confidence?: number };

export type AnswerPayload = {
  /** On a spoken question: how it was heard. */
  voice?: HeardPayload;
  steps?: StepDto[];
  reasoning?: string[];
  dataUsed?: DataUsedDto[];
  assumptions?: string[];
  confidence?: Confidence;
  confidenceReason?: string;
  spokenSummary?: string;
  suggestedPages?: SuggestedPage[];
  followUps?: string[];
  answerType?: "answer" | "clarification" | "cannot_answer";
  model?: string;
  privacy?: { enabled: boolean; tokens: number };
  usage?: { requests: number; promptTokens: number; outputTokens: number };
  progress?: ProgressLine[];
  errorKind?: string;
};

export type MessageStatus = "pending" | "running" | "done" | "error";

export type ChatMessage = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  status: MessageStatus;
  content: string;
  payload: AnswerPayload;
  error: string | null;
  inputMode: "text" | "voice";
  language: string | null;
  createdAt: string | null;
  finishedAt: string | null;
};

export type ConversationSummary = { id: number; title: string; updatedAt: string | null; createdAt: string | null };
export type ConversationDetail = ConversationSummary & { messages: ChatMessage[] };

export type AskBody = {
  question: string;
  conversationId?: number | null;
  inputMode?: "text" | "voice";
  language?: string;
  /** For a spoken question: the language heard, the recogniser's confidence and which engine transcribed it. */
  voice?: HeardPayload;
  pageContext?: unknown;
};

export type AskReply = { conversationId: number; userMessageId: number; messageId: number };

const base = "/api/md/assistant";

export const getStatus = () => customFetch<AssistantStatus>(`${base}/status`);

export const listConversations = () => customFetch<{ conversations: ConversationSummary[] }>(`${base}/conversations`);

export const getConversation = (id: number) => customFetch<ConversationDetail>(`${base}/conversations/${id}`);

export const deleteConversation = (id: number) =>
  customFetch<null>(`${base}/conversations/${id}`, { method: "DELETE" });

export const deleteAllConversations = () => customFetch<null>(`${base}/conversations`, { method: "DELETE" });

export const ask = (body: AskBody) =>
  customFetch<AskReply>(`${base}/ask`, { method: "POST", body: JSON.stringify(body) });

export const getMessage = (id: number) => customFetch<ChatMessage>(`${base}/messages/${id}`);

/** Stop an answer that is still being prepared. */
export const cancelMessage = (id: number) =>
  customFetch<ChatMessage & { stopped: boolean }>(`${base}/messages/${id}/cancel`, { method: "POST", body: "{}" });

/** Speech to text on the server (Gemini), for browsers that cannot recognise speech themselves. */
export function transcribe(audio: Blob, language?: string) {
  const form = new FormData();
  form.append(
    "audio",
    audio,
    `speech.${audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm"}`,
  );
  if (language) form.append("language", language);
  return customFetch<{ text: string; language: string }>(`${base}/transcribe`, { method: "POST", body: form });
}

/** What the server said went wrong, in words for the MD. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: string } | null;
    return data?.error || "The assistant could not be reached.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;
