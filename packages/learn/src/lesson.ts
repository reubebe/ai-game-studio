import { z } from "zod";

/**
 * Lessons attach learning objectives and quiz questions to a game. Every lesson carries an
 * evidence label so illustrative content is never presented as a validated scientific model.
 */
export const LESSON_SCHEMA_VERSION = "1.0.0";

const questionBase = { id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), prompt: z.string().trim().min(1).max(600), explanation: z.string().max(1200) };

export const questionSchema = z.discriminatedUnion("kind", [
  z.object({ ...questionBase, kind: z.literal("single"), options: z.array(z.string().min(1).max(200)).min(2).max(8), answer: z.number().int().min(0) }).strict(),
  z.object({ ...questionBase, kind: z.literal("multi"), options: z.array(z.string().min(1).max(200)).min(2).max(8), answers: z.array(z.number().int().min(0)).min(1) }).strict(),
  z.object({ ...questionBase, kind: z.literal("numeric"), answer: z.number().finite(), tolerance: z.number().min(0), unit: z.string().max(20) }).strict(),
]);
export type Question = z.infer<typeof questionSchema>;

export const lessonSchema = z
  .object({
    schemaVersion: z.literal(LESSON_SCHEMA_VERSION),
    kind: z.literal("lesson"),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: z.string().trim().min(1).max(120),
    subject: z.enum(["science", "neuroscience", "biomechanics", "mathematics", "philosophy", "history", "other"]),
    audience: z.string().max(120),
    objectives: z.array(z.string().min(1).max(300)).min(1).max(12),
    concepts: z.array(z.object({ term: z.string().min(1).max(80), definition: z.string().min(1).max(600) }).strict()).max(40),
    questions: z.array(questionSchema).min(1).max(60),
    masteryThreshold: z.number().min(0).max(1),
    evidence: z
      .object({
        status: z.enum(["illustrative", "simulated", "validated"]),
        statement: z.string().min(1).max(600),
        sources: z.array(z.object({ title: z.string().max(300), url: z.string().url().max(500).optional() }).strict()).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((lesson, ctx) => {
    const ids = new Set<string>();
    lesson.questions.forEach((q, i) => {
      if (ids.has(q.id)) ctx.addIssue({ code: "custom", path: ["questions", i, "id"], message: `Question id '${q.id}' is used twice` });
      ids.add(q.id);
      if (q.kind === "single" && q.answer >= q.options.length) ctx.addIssue({ code: "custom", path: ["questions", i, "answer"], message: "The answer must be one of the options" });
      if (q.kind === "multi" && q.answers.some((a) => a >= q.options.length)) ctx.addIssue({ code: "custom", path: ["questions", i, "answers"], message: "Every answer must be one of the options" });
    });
    if (lesson.evidence.status === "validated" && lesson.evidence.sources.length === 0) {
      ctx.addIssue({ code: "custom", path: ["evidence", "sources"], message: "A lesson marked validated must cite at least one source" });
    }
  });
export type Lesson = z.infer<typeof lessonSchema>;

export function parseLesson(input: unknown): { ok: true; lesson: Lesson } | { ok: false; errors: string[] } {
  const r = lessonSchema.safeParse(input);
  if (r.success) return { ok: true, lesson: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 30).map((i) => `${i.path.map(String).join(".") || "lesson"}: ${i.message}`) };
}

export type Response = number | number[] | null;

export function grade(question: Question, response: Response): boolean {
  switch (question.kind) {
    case "single":
      return response === question.answer;
    case "multi": {
      if (!Array.isArray(response)) return false;
      const a = [...new Set(response)].sort((x, y) => x - y);
      const b = [...new Set(question.answers)].sort((x, y) => x - y);
      return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    case "numeric":
      return typeof response === "number" && Number.isFinite(response) && Math.abs(response - question.answer) <= question.tolerance;
  }
}

export interface QuizSummary {
  correct: number;
  total: number;
  ratio: number;
  mastered: boolean;
  perQuestion: { id: string; correct: boolean }[];
}

export function summarize(lesson: Lesson, responses: Record<string, Response>): QuizSummary {
  const perQuestion = lesson.questions.map((q) => ({ id: q.id, correct: grade(q, responses[q.id] ?? null) }));
  const correct = perQuestion.filter((p) => p.correct).length;
  const total = lesson.questions.length;
  const ratio = total === 0 ? 0 : correct / total;
  return { correct, total, ratio, mastered: ratio >= lesson.masteryThreshold, perQuestion };
}

/** Sample lesson for the gait-lab idea in the blueprint. Values are textbook-style illustrations. */
export function gaitBasicsLesson(): Lesson {
  return {
    schemaVersion: LESSON_SCHEMA_VERSION,
    kind: "lesson",
    id: "gait-basics",
    title: "Gait basics: steps, cadence and walking speed",
    subject: "biomechanics",
    audience: "Introductory biomechanics or kinesiology students",
    objectives: [
      "Relate walking speed to step length and cadence.",
      "Distinguish a step from a stride.",
      "Describe the stance and swing phases of the gait cycle.",
    ],
    concepts: [
      { term: "Step length", definition: "Distance from the contact of one foot to the next contact of the opposite foot." },
      { term: "Stride length", definition: "Distance between two successive contacts of the same foot: two steps." },
      { term: "Cadence", definition: "Steps per minute." },
      { term: "Stance phase", definition: "Part of the gait cycle when the foot is on the ground; roughly 60% of the cycle in typical walking." },
      { term: "Swing phase", definition: "Part of the gait cycle when the foot is in the air; roughly 40% of the cycle in typical walking." },
    ],
    questions: [
      {
        id: "speed_calc",
        kind: "numeric",
        prompt: "A walker takes 110 steps per minute with a step length of 0.70 m. What is the walking speed in metres per second?",
        answer: 1.283,
        tolerance: 0.02,
        unit: "m/s",
        explanation: "Speed = step length x cadence / 60 = 0.70 x 110 / 60 = 1.28 m/s.",
      },
      {
        id: "stride_vs_step",
        kind: "single",
        prompt: "How many steps make one stride?",
        options: ["One", "Two", "Four"],
        answer: 1,
        explanation: "A stride runs from one foot's contact to the same foot's next contact, which takes two steps.",
      },
      {
        id: "longer_phase",
        kind: "single",
        prompt: "In typical walking, which phase takes up more of the gait cycle?",
        options: ["Stance", "Swing", "They are equal"],
        answer: 0,
        explanation: "Stance is about 60% of the cycle in typical walking; swing is about 40%.",
      },
      {
        id: "speed_factors",
        kind: "multi",
        prompt: "Which changes increase walking speed if everything else stays the same?",
        options: ["Longer steps", "Higher cadence", "Longer stance time per step"],
        answers: [0, 1],
        explanation: "Speed is step length times cadence. Spending longer in stance per step lowers cadence.",
      },
    ],
    masteryThreshold: 0.75,
    evidence: {
      status: "illustrative",
      statement: "Example values for teaching. This lesson is not a validated physiological model or clinical reference.",
      sources: [],
    },
  };
}
