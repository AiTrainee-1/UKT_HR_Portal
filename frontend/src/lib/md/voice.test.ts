import { describe, expect, it } from "vitest";
import {
  AUTO_SEND_CONFIDENCE,
  chooseRecorderMime,
  chunkForSpeech,
  describeHeard,
  languageForText,
  levelFromSamples,
  normalizeTranscript,
  pickVoice,
  recognitionLang,
  shouldAutoSend,
} from "./voice";

describe("languageForText", () => {
  it("tells the three languages apart by script", () => {
    expect(languageForText("Attendance was 91 percent")).toBe("en-IN");
    expect(languageForText("இன்று வருகை தொண்ணூற்று ஒன்று சதவீதம்")).toBe("ta-IN");
    expect(languageForText("आज उपस्थिति इक्यानवे प्रतिशत रही")).toBe("hi-IN");
  });

  it("keeps English when a few foreign words are mixed in, and has a default for no letters", () => {
    expect(languageForText("Stitching department வருகை was low this week and the team is working on it")).toBe("en-IN");
    expect(languageForText("1234 !!")).toBe("en-IN");
    expect(languageForText("")).toBe("en-IN");
  });

  it("treats mostly-Tamil text with some English as Tamil", () => {
    expect(languageForText("இன்று payroll பற்றி சொல்லுங்கள்")).toBe("ta-IN");
  });
});

describe("recognitionLang", () => {
  it("falls back to English for auto, as the browser cannot detect a language", () => {
    expect(recognitionLang("auto")).toBe("en-IN");
    expect(recognitionLang("ta-IN")).toBe("ta-IN");
  });
});

describe("chunkForSpeech", () => {
  it("splits into sentences", () => {
    expect(chunkForSpeech("Attendance was good today across all the units. Absenteeism fell to four percent.")).toEqual(
      ["Attendance was good today across all the units.", "Absenteeism fell to four percent."],
    );
  });

  it("merges very short neighbours so the voice does not stutter", () => {
    expect(chunkForSpeech("Yes. It was fourteen people.")).toEqual(["Yes. It was fourteen people."]);
  });

  it("breaks a long sentence at a comma or space under the limit", () => {
    const long =
      "Absenteeism rose in stitching, cutting and packing because of the festival week, and the units expect it to settle by next week once everyone is back";
    const chunks = chunkForSpeech(long, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("breaks an unbroken run of characters at the limit and handles Hindi full stops", () => {
    expect(chunkForSpeech("x".repeat(25), 10).map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunkForSpeech("आज उपस्थिति अच्छी रही। कल भी अच्छी थी।")).toEqual([
      "आज उपस्थिति अच्छी रही। कल भी अच्छी थी।",
    ]);
    expect(chunkForSpeech("   ")).toEqual([]);
  });
});

describe("pickVoice", () => {
  const voices = [
    { name: "Google US English", lang: "en-US", localService: false },
    { name: "Microsoft Heera - English (India)", lang: "en-IN", localService: true },
    { name: "Microsoft Neerja Online (Natural) - English (India)", lang: "en-IN", localService: false },
    { name: "Microsoft Valluvar - Tamil (India)", lang: "ta-IN", localService: true },
    { name: "Android Hindi", lang: "hi_IN", localService: true },
  ];

  it("prefers the exact language, then a natural voice, then one that works offline", () => {
    expect(pickVoice(voices, "en-IN")?.name).toBe("Microsoft Neerja Online (Natural) - English (India)");
    expect(
      pickVoice(
        voices.filter((v) => !/Natural/.test(v.name)),
        "en-IN",
      )?.name,
    ).toBe("Microsoft Heera - English (India)");
  });

  it("falls back to another English accent but never to the wrong language", () => {
    expect(pickVoice([voices[0]], "en-IN")?.name).toBe("Google US English");
    expect(pickVoice([voices[0]], "ta-IN")).toBeNull();
    expect(pickVoice([], "en-IN")).toBeNull();
  });

  it("understands the codes Android and Samsung report", () => {
    expect(pickVoice(voices, "hi-IN")?.name).toBe("Android Hindi"); // "hi_IN"
    expect(pickVoice([{ name: "Samsung Tamil", lang: "tam-IND", localService: true }], "ta-IN")?.name).toBe(
      "Samsung Tamil",
    );
    expect(pickVoice([{ name: "Plain Hindi", lang: "hi", localService: false }], "hi-IN")?.name).toBe("Plain Hindi");
  });
});

describe("describeHeard", () => {
  it("says what was heard, how sure the recogniser was and which engine did it", () => {
    expect(describeHeard({ language: "ta-IN", confidence: 0.934, engine: "browser" })).toBe(
      "Heard in Tamil · 93% sure · browser speech recognition",
    );
    expect(describeHeard({ language: "en-IN", engine: "server" })).toBe("Heard in English · transcribed by Gemini");
    expect(describeHeard({ language: "other" })).toBe("Heard in another language");
  });

  it("leaves out what is not known, and says nothing at all when nothing is", () => {
    expect(describeHeard({ confidence: 0 })).toBeNull();
    expect(describeHeard({})).toBeNull();
    expect(describeHeard(null)).toBeNull();
    expect(describeHeard(undefined)).toBeNull();
    expect(describeHeard({ language: "fr-FR" })).toBe("Heard in fr-FR");
  });
});

describe("transcripts", () => {
  it("normalises whitespace", () => {
    expect(normalizeTranscript("  show   me\n payroll ")).toBe("show me payroll");
  });

  it("sends a confident transcript at once and holds a doubtful one for review", () => {
    expect(shouldAutoSend("show me payroll", 0.9)).toBe(true);
    expect(shouldAutoSend("show me payroll", AUTO_SEND_CONFIDENCE)).toBe(true);
    expect(shouldAutoSend("show me payroll", 0.3)).toBe(false);
    expect(shouldAutoSend("show me payroll", null)).toBe(true); // some engines give no confidence
    expect(shouldAutoSend("show me payroll", 0)).toBe(true); // Chrome reports 0 for interim-only results
    expect(shouldAutoSend("ok", 0.99)).toBe(false); // too short to be a question
    expect(shouldAutoSend("   ", 0.99)).toBe(false);
  });
});

describe("levelFromSamples", () => {
  it("is zero for silence and rises with loudness, capped at one", () => {
    expect(levelFromSamples(new Uint8Array(64).fill(128))).toBe(0);
    expect(levelFromSamples([])).toBe(0);
    const quiet = levelFromSamples(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 133 : 123)));
    const loud = levelFromSamples(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 250 : 5)));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
  });
});

describe("chooseRecorderMime", () => {
  it("takes the first format the browser supports, in order of preference", () => {
    expect(chooseRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(chooseRecorderMime((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(chooseRecorderMime(() => false)).toBeNull();
  });
});
