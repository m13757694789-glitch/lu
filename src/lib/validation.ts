import { z } from "zod";
export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const idSchema = z.string().uuid();
export const courseSchema = z.object({ name: z.string().trim().min(1).max(100), color: z.string().regex(/^#[\da-f]{6}$/i).default("#7460aa"), description: z.string().max(2000).default("") });
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(value + "T12:00:00Z"); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }, "日期无效");
export const lessonSchema = z.object({ courseId: idSchema, title: z.string().trim().min(1).max(200), date: dateSchema });
export const contentSchema = z.array(z.object({ id: z.string().min(1), type: z.string().min(1), props: z.record(z.string(), z.unknown()).optional(), content: z.unknown().optional(), children: z.array(z.unknown()).optional() }).passthrough()).max(50000).superRefine((blocks, context) => {
  const allowed = new Set(["audio", "bulletListItem", "checkListItem", "codeBlock", "divider", "file", "heading", "image", "numberedListItem", "paragraph", "quote", "table", "toggleListItem", "video", "math"]);
  const ids = new Set<string>(); let count = 0;
  const walk = (items: unknown[], depth: number): boolean => {
    if (depth > 32) return false;
    for (const value of items) {
      if (!value || typeof value !== "object") return false;
      const block = value as { id?: string; type?: string; children?: unknown[]; props?: Record<string, unknown> };
      if (typeof block.id !== "string" || !block.id || ids.has(block.id) || typeof block.type !== "string" || !allowed.has(block.type) || ++count > 50000) return false;
      ids.add(block.id);
      if (block.type === "heading" && block.props?.level !== undefined && ![1, 2, 3].includes(block.props.level as number)) return false;
      if (block.children && (!Array.isArray(block.children) || !walk(block.children, depth + 1))) return false;
    }
    return true;
  };
  if (!walk(blocks, 0)) context.addIssue({ code: "custom", message: "笔记含有无效块、重复 ID 或过深的嵌套" });
});
export const lessonPatchSchema = lessonSchema.partial().extend({ content: contentSchema.optional(), revision: z.number().int().nonnegative() });
