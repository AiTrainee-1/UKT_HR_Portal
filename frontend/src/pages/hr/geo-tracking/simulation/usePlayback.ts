// Journey Simulation: the player. One requestAnimationFrame loop drives the clock (playback.ts does the arithmetic); the map
// marker follows it on every frame through `subscribe` (no React render per frame), and the page's figures (clock, progress,
// what the employee is doing) are refreshed about ten times a second. Every frame and timer is cancelled on pause, on a new
// journey and on unmount.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SPEED,
  clampT,
  keyMoments,
  nextMoment,
  previousMoment,
  rateFor,
  tick,
  type Clock,
  type SimTrack,
  type SpeedChoice,
} from "./playback";

/** How often the figures beside the map are refreshed while playing (the marker moves on every frame). */
const UI_EVERY_MS = 100;

/** True when the person asked their system for less motion (and follows a change of that setting). */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setReduced(list.matches);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export type PlaybackStatus = "idle" | "playing" | "paused" | "ended";

export type Playback = {
  /** The clock as the page shows it (refreshed ~10 times a second while playing). */
  t: number;
  status: PlaybackStatus;
  /** Waiting at a gap before jumping across it. */
  holding: boolean;
  speed: SpeedChoice;
  /** Recorded milliseconds per real millisecond at the chosen speed. */
  rate: number;
  play: () => void;
  pause: () => void;
  /** Back to the start, not playing. */
  stop: () => void;
  /** From the start, playing. */
  replay: () => void;
  seek: (t: number) => void;
  setSpeed: (speed: SpeedChoice) => void;
  /** Step-through: the next / previous moment worth stopping at (an arrival, a departure, a gap, the end). */
  stepForward: () => void;
  stepBack: () => void;
  /** Called with the clock on every frame and on every jump (the map marker); returns the unsubscribe. */
  subscribe: (listener: (t: number) => void) => () => void;
};

export function usePlayback(track: SimTrack): Playback {
  const [t, setT] = useState(track.startT);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [holding, setHolding] = useState(false);
  const [speed, setSpeedState] = useState<SpeedChoice>(DEFAULT_SPEED);
  const rate = rateFor(speed, track.durationMs);

  const clock = useRef<Clock>({ t: track.startT, holdMs: 0 });
  const frame = useRef<number | null>(null);
  const last = useRef(0);
  const lastUi = useRef(0);
  const listeners = useRef(new Set<(t: number) => void>());
  // the latest track and rate for the frame loop, without restarting it when a live journey grows
  const latest = useRef({ track, rate });
  latest.current = { track, rate };
  const moments = useMemo(() => keyMoments(track), [track]);

  const emit = useCallback((value: number) => {
    for (const fn of listeners.current) fn(value);
  }, []);

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const loop = useCallback(
    (now: number) => {
      const { track: tr, rate: r } = latest.current;
      const dt = last.current ? Math.min(250, now - last.current) : 0; // a background tab does not leap ahead on return
      last.current = now;
      const next = tick(tr, clock.current, dt, r);
      clock.current = next;
      emit(next.t);
      const ended = next.t >= tr.endT && next.holdMs === 0;
      if (ended || now - lastUi.current >= UI_EVERY_MS) {
        lastUi.current = now;
        setT(next.t);
        setHolding(next.holdMs > 0);
      }
      if (ended) {
        frame.current = null;
        setStatus("ended");
        return;
      }
      frame.current = requestAnimationFrame(loop);
    },
    [emit],
  );

  const seek = useCallback(
    (value: number) => {
      const target = clampT(latest.current.track, value);
      clock.current = { t: target, holdMs: 0 };
      setT(target);
      setHolding(false);
      emit(target);
      setStatus((s) => (s === "playing" ? s : target >= latest.current.track.endT ? "ended" : "paused"));
    },
    [emit],
  );

  const play = useCallback(() => {
    const tr = latest.current.track;
    if (tr.points.length < 2 || tr.durationMs <= 0) return;
    if (clock.current.t >= tr.endT) clock.current = { t: tr.startT, holdMs: 0 };
    cancel();
    last.current = 0;
    lastUi.current = 0;
    setStatus("playing");
    frame.current = requestAnimationFrame(loop);
  }, [cancel, loop]);

  const pause = useCallback(() => {
    cancel();
    setT(clock.current.t);
    setStatus((s) => (s === "playing" ? "paused" : s));
  }, [cancel]);

  const stop = useCallback(() => {
    cancel();
    setStatus("idle");
    seek(latest.current.track.startT);
    setStatus("idle");
  }, [cancel, seek]);

  const replay = useCallback(() => {
    clock.current = { t: latest.current.track.startT, holdMs: 0 };
    emit(clock.current.t);
    play();
  }, [emit, play]);

  const stepForward = useCallback(() => {
    pause();
    const m = nextMoment(moments, clock.current.t);
    if (m) seek(m.t);
  }, [moments, pause, seek]);

  const stepBack = useCallback(() => {
    pause();
    const m = previousMoment(moments, clock.current.t);
    if (m) seek(m.t);
  }, [moments, pause, seek]);

  const subscribe = useCallback((listener: (t: number) => void) => {
    listeners.current.add(listener);
    listener(clock.current.t);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  // another journey: back to its start, stopped. A live journey that only grew keeps its place (and plays on).
  const identity = track.points.length ? `${track.points[0].t}|${track.source}` : "none";
  useEffect(() => {
    cancel();
    clock.current = { t: latest.current.track.startT, holdMs: 0 };
    setT(clock.current.t);
    setHolding(false);
    setStatus("idle");
    emit(clock.current.t);
  }, [identity, cancel, emit]);

  // never a frame after the page is gone
  useEffect(() => cancel, [cancel]);

  return {
    t,
    status,
    holding,
    speed,
    rate,
    play,
    pause,
    stop,
    replay,
    seek,
    setSpeed: setSpeedState,
    stepForward,
    stepBack,
    subscribe,
  };
}
