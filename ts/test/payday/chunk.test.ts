import { describe, it, expect } from "vitest";
import { chunk } from "../../src/payday/chunk.js";

describe("chunk", () => {
  // WHY: payday batch boundaries map 1:1 to PTBs; a wrong split over/under-fills a PTB
  // and breaks the spec §13 object-mutation budget.
  it("empty input -> no chunks", () => {
    expect(chunk([], 50)).toEqual([]);
  });
  it("exact multiple -> full chunks", () => {
    expect(chunk(Array.from({ length: 100 }, (_, i) => i), 50).map((c) => c.length)).toEqual([50, 50]);
  });
  it("remainder -> trailing short chunk", () => {
    expect(chunk(Array.from({ length: 51 }, (_, i) => i), 50).map((c) => c.length)).toEqual([50, 1]);
  });
  it("single chunk when under size", () => {
    expect(chunk([1], 50).map((c) => c.length)).toEqual([1]);
  });
  it("preserves order", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  it("rejects non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});
