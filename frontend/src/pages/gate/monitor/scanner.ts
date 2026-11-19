// The gate's input and voice: a USB / Bluetooth QR scanner in keyboard-wedge mode (it "types" the code and presses
// Enter, much faster than a person), the WebHID view of whether one is plugged in, and spoken feedback through the
// browser's own speech. Ported from the old gate scanner console.

import { useCallback, useEffect, useRef, useState } from "react";

// Scanner keystrokes land within a couple of ms of each other; a slower key is a person typing, not a scan.
export const WEDGE_RESET_GAP_MS = 50;
// Every gate code is longer than this (a short code is about 25-40 characters, an old one about 200).
export const MIN_SCAN_LENGTH = 12;
// A scanner can fire twice for one pass: the same code again within this window is ignored.
export const DUPLICATE_GUARD_MS = 2000;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
}

/**
 * The connected scanner IS this listener: a page-wide keydown listener that collects a fast burst of keys and hands it
 * over on Enter. While a text box has the focus it stays out of the way (the box has its own Enter: the typed-code form
 * scans what it holds, the search box searches).
 */
export function useWedgeScanner(onScan: (raw: string) => void): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let buffer = "";
    let lastCharAt = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) {
        buffer = "";
        return;
      }
      if (e.key === "Enter") {
        const value = buffer.trim();
        buffer = "";
        lastCharAt = 0;
        if (value.length >= MIN_SCAN_LENGTH) {
          // a focused button must not be "clicked" by the scanner's Enter
          e.preventDefault();
          onScanRef.current(value);
        }
        return;
      }
      const now = Date.now();
      if (now - lastCharAt > WEDGE_RESET_GAP_MS) buffer = "";
      lastCharAt = now;
      if (e.key.length === 1) buffer += e.key;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** A repeat of the same code within DUPLICATE_GUARD_MS is a double read: `accept` says false for it. */
export function makeDuplicateGuard(windowMs = DUPLICATE_GUARD_MS, clock: () => number = Date.now) {
  let last = { value: "", at: 0 };
  return (raw: string): boolean => {
    const now = clock();
    if (raw === last.value && now - last.at < windowMs) return false;
    last = { value: raw, at: now };
    return true;
  };
}

// ── is a scanner plugged in (WebHID) ─────────────────────────────────────────────────────────────────────────────
// A wedge scanner types like a keyboard, so nothing on the page proves one is attached before it is used. WebHID can see
// a paired device come and go, but Chrome never lists a device that says it is a keyboard (to stop pages snooping on
// keyboards), and many scanners say exactly that: "Pair scanner" may find nothing while scanning works fine. The badge
// reports what the browser can see, nothing more.

export type ScannerStatus = "checking" | "connected" | "disconnected" | "unsupported";

type HidLike = {
  getDevices: () => Promise<unknown[]>;
  requestDevice: (opts: { filters: unknown[] }) => Promise<unknown[]>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
};

function hid(): HidLike | null {
  if (typeof navigator === "undefined" || !("hid" in navigator)) return null;
  return (navigator as unknown as { hid: HidLike }).hid ?? null;
}

export function useScannerConnection() {
  const [status, setStatus] = useState<ScannerStatus>("checking");

  const refresh = useCallback(async () => {
    const api = hid();
    if (!api) {
      setStatus("unsupported");
      return;
    }
    try {
      const devices = await api.getDevices();
      setStatus(devices.length > 0 ? "connected" : "disconnected");
    } catch {
      setStatus("disconnected");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const api = hid();
    if (!api) return;
    api.addEventListener("connect", refresh);
    api.addEventListener("disconnect", refresh);
    return () => {
      api.removeEventListener("connect", refresh);
      api.removeEventListener("disconnect", refresh);
    };
  }, [refresh]);

  const pair = useCallback(async () => {
    const api = hid();
    if (!api) return;
    try {
      const picked = await api.requestDevice({ filters: [] });
      if (picked.length > 0) setStatus("connected");
    } catch {
      // cancelled, or the browser offered nothing: leave the status as it is
    }
  }, []);

  return { status, pair };
}

// ── voice ────────────────────────────────────────────────────────────────────────────────────────────────────────

const VOICE_LANG = "en-IN";
const VOICE_KEY = "gate_monitor_voice";

export function voiceEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setVoiceEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(VOICE_KEY);
    else localStorage.setItem(VOICE_KEY, "off");
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

// Voices load late in most browsers (an empty list until "voiceschanged"): wait for it once, at most half a second.
function voices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) return resolve(existing);
    const onChange = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onChange);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", onChange);
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 500);
  });
}

/** Says `text` (en-IN when the browser has it). Never throws: the voice only adds to what the screen shows. */
export async function speak(text: string): Promise<void> {
  try {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !voiceEnabled()) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = VOICE_LANG;
    utter.rate = 0.95;
    const list = await voices();
    const match = list.find((v) => v.lang === VOICE_LANG) ?? list.find((v) => v.lang?.toLowerCase().startsWith("en"));
    if (match) utter.voice = match;
    window.speechSynthesis.speak(utter);
  } catch {
    /* no speech on this kiosk */
  }
}
