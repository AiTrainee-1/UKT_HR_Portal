// The conversation with the assistant: sending a question, following the answer while it is prepared (the server works
// in the background and the browser polls the message), history, and starting afresh.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getAssistantState } from "@/lib/md/assistant-store";
import {
  ask,
  cancelMessage,
  deleteAllConversations,
  deleteConversation,
  errorText,
  getConversation,
  getMessage,
  isUnauthorized,
  listConversations,
  type ChatMessage,
  type ConversationSummary,
  type HeardPayload,
} from "./api";

const FIRST_POLL_MS = 500;
const POLL_MS = 900;
const SLOW_POLL_MS = 1600;
const SLOW_AFTER_MS = 15_000;
const MAX_POLL_FAILURES = 5;

const isActive = (m: ChatMessage) => m.role === "assistant" && (m.status === "pending" || m.status === "running");

let tempId = 0;
const nextTempId = () => --tempId;

function localMessage(role: ChatMessage["role"], fields: Partial<ChatMessage>): ChatMessage {
  return {
    id: nextTempId(),
    conversationId: 0,
    role,
    status: "done",
    content: "",
    payload: {},
    error: null,
    inputMode: "text",
    language: null,
    createdAt: null,
    finishedAt: null,
    ...fields,
  };
}

export function useAssistantChat(options: { onAnswered?: (message: ChatMessage) => void } = {}) {
  const { logout } = useAuth();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const onAnswered = useRef(options.onAnswered);
  onAnswered.current = options.onAnswered;
  const conversationRef = useRef<number | null>(null);
  conversationRef.current = conversationId;

  const busy = useMemo(() => messages.some(isActive), [messages]);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const activeId = useMemo(() => messages.find((m) => isActive(m) && m.id > 0)?.id ?? null, [messages]);

  const fail = useCallback(
    (error: unknown) => {
      if (isUnauthorized(error)) logout();
      return errorText(error);
    },
    [logout],
  );

  // Follow the answer being prepared.
  useEffect(() => {
    if (activeId == null) return;
    let cancelled = false;
    let timer = 0;
    let failures = 0;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const next = await getMessage(activeId);
        if (cancelled) return;
        failures = 0;
        setMessages((prev) => prev.map((m) => (m.id === next.id ? next : m)));
        if (next.status === "done") onAnswered.current?.(next);
        else if (next.status === "pending" || next.status === "running") {
          timer = window.setTimeout(tick, Date.now() - startedAt > SLOW_AFTER_MS ? SLOW_POLL_MS : POLL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        if (isUnauthorized(error)) return void logout();
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === activeId
                ? { ...m, status: "error", error: "I lost the connection to the server. Please try again." }
                : m,
            ),
          );
        } else {
          timer = window.setTimeout(tick, 2000);
        }
      }
    };
    timer = window.setTimeout(tick, FIRST_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeId, logout]);

  const send = useCallback(
    async (text: string, opts: { inputMode?: "text" | "voice"; language?: string; voice?: HeardPayload } = {}) => {
      const question = text.trim();
      if (!question || busyRef.current) return false;
      const user = localMessage("user", {
        content: question,
        inputMode: opts.inputMode ?? "text",
        payload: opts.voice ? { voice: opts.voice } : {},
      });
      const pending = localMessage("assistant", {
        status: "pending",
        inputMode: opts.inputMode ?? "text",
        payload: { progress: [{ label: "Reading your question", state: "running" }] },
      });
      setMessages((prev) => [...prev, user, pending]);
      try {
        const reply = await ask({
          question,
          conversationId: conversationRef.current,
          inputMode: opts.inputMode ?? "text",
          language: opts.language,
          voice: opts.voice,
          pageContext: getAssistantState().context,
        });
        setConversationId(reply.conversationId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === user.id
              ? { ...m, id: reply.userMessageId, conversationId: reply.conversationId }
              : m.id === pending.id
                ? { ...m, id: reply.messageId, conversationId: reply.conversationId }
                : m,
          ),
        );
        return true;
      } catch (error) {
        const message = fail(error);
        setMessages((prev) => prev.map((m) => (m.id === pending.id ? { ...m, status: "error", error: message } : m)));
        return false;
      }
    },
    [fail],
  );

  /** Stop the answer being prepared (it ends as "Stopped." and the box is free for the next question). */
  const stop = useCallback(async () => {
    if (activeId == null) return;
    try {
      const stopped = await cancelMessage(activeId);
      setMessages((prev) => prev.map((m) => (m.id === stopped.id ? stopped : m)));
    } catch (error) {
      fail(error);
    }
  }, [activeId, fail]);

  const newChat = useCallback(() => {
    setConversationId(null);
    setMessages([]);
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory((await listConversations()).conversations);
    } catch (error) {
      fail(error);
    } finally {
      setHistoryLoading(false);
    }
  }, [fail]);

  const openConversation = useCallback(
    async (id: number) => {
      try {
        const detail = await getConversation(id);
        setConversationId(detail.id);
        setMessages(detail.messages);
      } catch (error) {
        fail(error);
      }
    },
    [fail],
  );

  const removeConversation = useCallback(
    async (id: number) => {
      try {
        await deleteConversation(id);
        setHistory((prev) => prev.filter((c) => c.id !== id));
        if (conversationRef.current === id) newChat();
      } catch (error) {
        fail(error);
      }
    },
    [fail, newChat],
  );

  const clearAll = useCallback(async () => {
    try {
      await deleteAllConversations();
      setHistory([]);
      newChat();
    } catch (error) {
      fail(error);
    }
  }, [fail, newChat]);

  return {
    messages,
    busy,
    conversationId,
    history,
    historyLoading,
    send,
    stop,
    newChat,
    refreshHistory,
    openConversation,
    removeConversation,
    clearAll,
  };
}
