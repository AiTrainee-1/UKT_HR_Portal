import { describe, expect, it } from "vitest";
import { roundToPaise, roundUpRupee } from "./round-up-rupee";

describe("roundUpRupee", () => {
  it("rounds any paise up to the next whole rupee, as the Salary Statement prints NET and ESI", () => {
    expect(roundUpRupee(89.11)).toBe(90);
    expect(roundUpRupee(89.66)).toBe(90);
    expect(roundUpRupee(14444.44)).toBe(14445);
    expect(roundUpRupee(13489.76)).toBe(13490);
  });

  it("leaves a whole rupee as it is", () => {
    expect(roundUpRupee(89)).toBe(89);
    expect(roundUpRupee(24000)).toBe(24000);
  });

  it("never adds a rupee for float noise below a paisa", () => {
    expect(roundUpRupee(7999.9999999998)).toBe(8000);
    expect(roundUpRupee(8000.0000000002)).toBe(8000);
    expect(roundToPaise(0.1 + 0.2)).toBe(0.3);
  });

  it("rounds a negative net towards zero, like the server's ROUND_CEILING", () => {
    expect(roundUpRupee(-12.5)).toBe(-12);
  });
});
