import { z } from "zod";
import { courseSchema, lessonSchema, contentSchema, idSchema } from "./validation.ts";
export const manifestSchema = z.object({
  format: z.literal("classnote"), version: z.literal(1),
  courses: z.array(courseSchema.extend({ id: idSchema, archived: z.number().int().min(0).max(1), createdAt: z.string().datetime() })).max(10000),
  lessons: z.array(lessonSchema.extend({ id: idSchema, content: contentSchema, revision: z.number().int().nonnegative(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), visitedAt: z.string().datetime().nullable() })).max(100000),
  attachments: z.array(z.object({ id: idSchema, lessonId: idSchema, name: z.string().min(1).max(240), kind: z.enum(["audio", "image"]), mime: z.string().regex(/^(audio\/(mpeg|mp4|wav|ogg|aac|flac|webm)|image\/(jpeg|png|webp|gif))$/), size: z.number().int().positive().max(8 * 1024 ** 3), filename: z.string().regex(/^[\da-f-]{36}\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|webm|jpg|jpeg|png|webp|gif)$/), sha256: z.string().regex(/^[\da-f]{64}$/), position: z.number().finite().min(0), createdAt: z.string().datetime() })).max(100000),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;
