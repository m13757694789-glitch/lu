import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { textOf, mapAttachmentUrls, type Attachment, type Course, type Lesson, type Library } from "./models.ts";

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
const now = () => new Date().toISOString();

export class Store {
  db: DatabaseSync;
  directory: string;
  files: string;
  temporary: string;
  constructor(directory: string) {
    this.directory = resolve(directory); this.files = join(this.directory, "files"); this.temporary = join(this.directory, "tmp");
    mkdirSync(this.files, { recursive: true }); mkdirSync(this.temporary, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, "library.sqlite"));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, description TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY, courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL, date TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, visitedAt TEXT);
      CREATE INDEX IF NOT EXISTS lessons_course ON lessons(courseId, date);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, lessonId TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, position REAL NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_lesson ON attachments(lessonId);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;`);
  }
  course(id: string): Course {
    const row = this.db.prepare("SELECT * FROM courses WHERE id=?").get(id) as Course | undefined;
    if (!row) throw new AppError("课程不存在", 404); return row;
  }
  lesson(id: string): Lesson {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id=?").get(id) as (Omit<Lesson, "content"> & { content: string }) | undefined;
    if (!row) throw new AppError("课堂记录不存在", 404); return { ...row, content: JSON.parse(row.content) };
  }
  attachment(id: string): Attachment {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id=?").get(id) as Attachment | undefined;
    if (!row) throw new AppError("附件不存在", 404); return row;
  }
  library(): Library {
    return { courses: this.db.prepare("SELECT * FROM courses ORDER BY createdAt").all() as Course[],
      lessons: this.db.prepare("SELECT * FROM lessons ORDER BY date DESC, createdAt DESC").all().map(row => ({ ...row, content: JSON.parse(row.content as string) })) as Lesson[],
      settings: Object.fromEntries(this.db.prepare("SELECT * FROM settings").all().map(row => [row.key, JSON.parse(row.value as string)])) };
  }
  detail(id: string, visit = false) {
    if (visit) this.db.prepare("UPDATE lessons SET visitedAt=? WHERE id=?").run(now(), id);
    return { ...this.lesson(id), attachments: this.db.prepare("SELECT * FROM attachments WHERE lessonId=? ORDER BY createdAt").all(id) as Attachment[] };
  }
  createCourse(input: unknown) {
    const data = courseSchema.parse(input); const row = { id: randomUUID(), ...data, archived: 0, createdAt: now() };
    this.db.prepare("INSERT INTO courses VALUES(?,?,?,?,?,?)").run(row.id, row.name, row.color, row.description, row.archived, row.createdAt); return row;
  }
  updateCourse(id: string, input: unknown) {
    const data = courseSchema.partial().extend({ color: z.string().regex(/^#[\da-f]{6}$/i).optional(), description: z.string().max(2000).optional(), archived: z.boolean().optional() }).parse(input); const old = this.course(id);
    this.db.prepare("UPDATE courses SET name=?, color=?, description=?, archived=? WHERE id=?").run(data.name ?? old.name, data.color ?? old.color, data.description ?? old.description, data.archived === undefined ? old.archived : Number(data.archived), id); return this.course(id);
  }
  createLesson(input: unknown) {
    const data = lessonSchema.parse(input); this.course(data.courseId); const stamp = now();
    const id = randomUUID(); const content = [{ id: randomUUID(), type: "paragraph", content: [] }];
    this.db.prepare("INSERT INTO lessons VALUES(?,?,?,?,?,0,?,?,NULL)").run(id, data.courseId, data.title, data.date, JSON.stringify(content), stamp, stamp); return this.detail(id);
  }
  updateLesson(id: string, input: unknown) {
    const data = lessonPatchSchema.parse(input); const old = this.lesson(id);
    if (data.courseId) this.course(data.courseId);
    if (data.content) {
      mapAttachmentUrls(data.content, attachmentId => {
        const file = this.attachment(attachmentId);
        if (file.lessonId !== id) throw new AppError("图片必须属于当前课堂；请在当前课堂重新上传");
        return attachmentId;
      });
    }
    const result = this.db.prepare("UPDATE lessons SET courseId=?, title=?, date=?, content=?, revision=revision+1, updatedAt=? WHERE id=? AND revision=?")
      .run(data.courseId ?? old.courseId, data.title ?? old.title, data.date ?? old.date, JSON.stringify(data.content ?? old.content), now(), id, data.revision);
    if (!result.changes) throw new AppError("这节课已在其他窗口修改。当前草稿已保留，请先导出草稿，再重新加载。", 409);
    return this.lesson(id);
  }
  deleteCourse(id: string) { this.course(id); this.db.prepare("DELETE FROM courses WHERE id=?").run(id); }
  deleteLesson(id: string) { this.lesson(id); this.db.prepare("DELETE FROM lessons WHERE id=?").run(id); }
  addAttachment(row: Attachment) {
    this.lesson(row.lessonId);
    this.db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?)").run(row.id, row.lessonId, row.name, row.kind, row.mime, row.size, row.filename, row.sha256, row.position, row.createdAt); return row;
  }
  updateAttachment(id: string, input: unknown) {
    const data = z.object({ name: z.string().trim().min(1).max(240).optional(), position: z.number().finite().min(0).max(1e8).optional() }).parse(input); const old = this.attachment(id);
    this.db.prepare("UPDATE attachments SET name=?, position=? WHERE id=?").run(data.name ?? old.name, data.position ?? old.position, id); return this.attachment(id);
  }
  deleteAttachment(id: string) {
    const row = this.attachment(id);
    if (row.kind === "image" && JSON.stringify(this.lesson(row.lessonId).content).includes(`/api/files/${id}`)) throw new AppError("图片仍在正文中，请先删除对应图片块");
    this.db.prepare("DELETE FROM attachments WHERE id=?").run(id);
  }
  settings(input: unknown) {
    const data = z.record(z.string().max(100), z.unknown()).parse(input);
    this.transaction(() => { for (const [key, value] of Object.entries(data)) this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); });
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE"); try { const result = run(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  filePath(row: Attachment) {
    if (!/^[\da-f-]{36}\.[a-z0-9]{1,8}$/.test(row.filename)) throw new AppError("附件路径无效", 500);
    const path = join(this.files, row.filename); if (!existsSync(path) || !statSync(path).isFile()) throw new AppError("附件文件缺失，请从备份恢复", 404); return path;
  }
  searchText(id: string) { return textOf(this.lesson(id).content); }
  close() { this.db.close(); }
}

const globalStore = globalThis as typeof globalThis & { classnoteStore?: Store };
export function getStore() {
  return globalStore.classnoteStore ??= new Store(process.env.CLASSNOTE_DATA_DIR || join(process.cwd(), ".classnote"));
}
