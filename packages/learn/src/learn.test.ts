import { describe, expect, it } from "vitest";
import { gaitBasicsLesson, grade, parseLesson, summarize } from "./index";

describe("lessons", () => {
  it("validates the sample lesson and labels it illustrative", () => {
    const r = parseLesson(gaitBasicsLesson());
    expect(r.ok).toBe(true);
    expect(gaitBasicsLesson().evidence.status).toBe("illustrative");
  });

  it("requires sources before a lesson can be marked validated", () => {
    const l = gaitBasicsLesson();
    l.evidence.status = "validated";
    const r = parseLesson(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/must cite at least one source/);
  });

  it("rejects answers that are not among the options", () => {
    const l = gaitBasicsLesson();
    const q = l.questions[1]!;
    if (q.kind === "single") q.answer = 7;
    expect(parseLesson(l).ok).toBe(false);
  });

  it("grades numeric answers within tolerance and multi-select answers as sets", () => {
    const [speed, , , factors] = gaitBasicsLesson().questions;
    expect(grade(speed!, 1.28)).toBe(true);
    expect(grade(speed!, 1.4)).toBe(false);
    expect(grade(factors!, [1, 0])).toBe(true);
    expect(grade(factors!, [0])).toBe(false);
    expect(grade(factors!, null)).toBe(false);
  });

  it("checks the worked example arithmetic", () => {
    expect((0.7 * 110) / 60).toBeCloseTo(1.283, 3);
  });

  it("summarizes mastery against the threshold", () => {
    const lesson = gaitBasicsLesson();
    expect(summarize(lesson, { speed_calc: 1.28, stride_vs_step: 1, longer_phase: 0, speed_factors: [0, 1] })).toMatchObject({ correct: 4, mastered: true });
    expect(summarize(lesson, { speed_calc: 1.28, stride_vs_step: 1 })).toMatchObject({ correct: 2, mastered: false });
  });
});
