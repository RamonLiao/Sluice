// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AllocationMeter } from "./AllocationMeter.js";

describe("AllocationMeter", () => {
  it("renders 4 segments with widths proportional to bps", () => {
    const { container } = render(
      <AllocationMeter taxBps={0} liquidBps={5000} scallopBps={3000} naviBps={2000} />,
    );
    const segs = container.querySelectorAll("[data-seg]");
    expect(segs.length).toBe(4);
    expect((segs[1] as HTMLElement).style.width).toBe("50%"); // liquid 5000bps
  });
});
