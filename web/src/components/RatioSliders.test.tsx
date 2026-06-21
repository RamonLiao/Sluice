import { describe, it, expect } from "vitest";
import { ratioError } from "./RatioSliders.js";

describe("ratioError", () => {
  it("rejects bps not summing to 10000", () => {
    expect(ratioError({ liquidBps: 5000, scallopBps: 3000, naviBps: 1000 })).toMatch(/10000/);
  });
  it("accepts an exact 10000 split", () => {
    expect(ratioError({ liquidBps: 5000, scallopBps: 3000, naviBps: 2000 })).toBeNull();
  });
});
