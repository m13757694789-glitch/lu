import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import archiver from "archiver";
import { PassThrough } from "node:stream";
import { Store } from "../src/lib/storage.ts";
import { upload, serveFile } from "../src/lib/files.ts";
import { exportBackup, restoreBackup } from "../src/lib/backup.ts";
const root = resolve(".classnote-test"); mkdirSync(root, { recursive: true });
function isolated() { const directory = mkdtempSync(join(root, "case-")); const store = new Store(directory); return { store, directory, cleanup() { store.close(); assert.ok(directory.startsWith(root + sep)); rmSync(directory, { recursive: true, force: true }); } }; }
function request(body: Uint8Array, name: string) { return new Request("http://127.0.0.1:3210/api/upload", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "x-file-size": String(body.length) }, body: body as BodyInit }); }
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V4kAAAAASUVORK5CYII=", "base64");

test("stable IDs preserve three lessons, image placement and audio when renamed and reopened", async () => {
  const env = isolated(); let store = env.store;
  try {
    const course = store.createCourse({ name: "工程力学", color: "#5f8a7c", description: "测试课程" });
    const lessons = ["力矩", "平面力系", "力偶"].map(title => store.createLesson({ courseId: course.id, title, date: "2026-10-14" }));
    const first = lessons[0]; const imageA = await upload(request(png, "板书A.png"), store, first.id); const imageB = await upload(request(png, "板书B.png"), store, first.id);
    const audio = await upload(request(Buffer.from("ID3-test-audio"), "课堂.mp3"), store, first.id);
    const content = [ { id: "img-b", type: "image", props: { url: `/api/files/${imageB.id}`, previewWidth: 320 } }, { id: "p1", type: "paragraph", content: "第一段" }, { id: "img-a", type: "image", props: { url: `/api/files/${imageA.id}`, previewWidth: 480 } }, { id: "p2", type: "paragraph", content: "第二段" }, { id: "p3", type: "paragraph", content: "第三段" } ];
    store.updateLesson(first.id, { title: "修改后的课堂", content, revision: 0 }); store.updateCourse(course.id, { name: "工程力学（重命名）" });
    store.close(); store = new Store(env.directory); env.store = store;
    assert.equal(store.library().lessons.length, 3); assert.equal(store.course(course.id).color, "#5f8a7c"); assert.equal(store.course(course.id).description, "测试课程");
    assert.deepEqual(store.lesson(first.id).content, content); assert.equal(store.detail(first.id).attachments.length, 3); assert.deepEqual(readFileSync(store.filePath(imageA)), png); assert.ok(existsSync(store.filePath(audio)));
  } finally { store.close(); assert.ok(env.directory.startsWith(root + sep)); rmSync(env.directory, { recursive: true, force: true }); }
});
test("version conflicts never overwrite saved content; moving and deleting preserve unrelated records", () => {
  const env = isolated(); try { const a = env.store.createCourse({ name: "A" }); const b = env.store.createCourse({ name: "B" }); const lesson = env.store.createLesson({ courseId: a.id, title: "最初", date: "2026-10-14" });
    env.store.updateLesson(lesson.id, { title: "新版本", revision: 0 }); assert.throws(() => env.store.updateLesson(lesson.id, { title: "旧窗口", revision: 0 }), /其他窗口/); assert.equal(env.store.lesson(lesson.id).title, "新版本");
    env.store.updateLesson(lesson.id, { courseId: b.id, revision: 1 }); env.store.deleteCourse(a.id); assert.equal(env.store.lesson(lesson.id).courseId, b.id); env.store.deleteCourse(b.id); assert.equal(env.store.library().lessons.length, 0);
  } finally { env.cleanup(); }
});
test("invalid block structures are rejected, while file URL examples remain plain note text", () => {
  const env = isolated(); try {
    const course = env.store.createCourse({ name: "格式检查" }); const lesson = env.store.createLesson({ courseId: course.id, title: "代码示例", date: "2026-10-14" });
    assert.throws(() => env.store.updateLesson(lesson.id, { revision: 0, content: [{ id: "bad", type: "unsupported-block" }] }));
    assert.throws(() => env.store.updateLesson(lesson.id, { revision: 0, content: [{ id: "same", type: "paragraph" }, { id: "same", type: "paragraph" }] }));
    const literal = `/api/files/${randomUUID()}`;
    env.store.updateLesson(lesson.id, { revision: 0, content: [{ id: "literal", type: "codeBlock", content: literal }] });
    assert.ok(env.store.searchText(lesson.id).includes(literal));
  } finally { env.cleanup(); }
});
test("upload validates lengths and image signatures; images in use cannot be deleted", async () => {
  const env = isolated(); try { const course = env.store.createCourse({ name: "A" }); const lesson = env.store.createLesson({ courseId: course.id, title: "A", date: "2026-10-14" });
    await assert.rejects(upload(request(Buffer.from("not-a-png"), "fake.png"), env.store, lesson.id), /格式不符/);
    const partial = request(png, "short.png"); partial.headers.set("x-file-size", String(png.length + 1)); await assert.rejects(upload(partial, env.store, lesson.id), /不完整/);
    const image = await upload(request(png, "图.png"), env.store, lesson.id); env.store.updateLesson(lesson.id, { revision: 0, content: [{ id: "image1", type: "image", props: { url: `/api/files/${image.id}` } }] }); assert.throws(() => env.store.deleteAttachment(image.id), /仍在正文/);
    assert.equal(env.store.detail(lesson.id).attachments.length, 1);
  } finally { env.cleanup(); }
});
test("audio Range supports seeking, suffix ranges, HEAD and invalid ranges", async () => {
  const env = isolated(); try { const course = env.store.createCourse({ name: "A" }); const lesson = env.store.createLesson({ courseId: course.id, title: "A", date: "2026-10-14" }); const body = Buffer.from("0123456789"); const audio = await upload(request(body, "录音.mp3"), env.store, lesson.id);
    const get = (range: string, method = "GET") => serveFile(new Request("http://127.0.0.1/api/files/a", { method, headers: { range } }), env.store, audio);
    const range = get("bytes=2-5"); assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 2-5/10"); assert.equal(await range.text(), "2345"); assert.equal(await get("bytes=-3").text(), "789"); assert.equal(get("bytes=50-").status, 416); assert.equal(await get("bytes=2-5", "HEAD").text(), "");
  } finally { env.cleanup(); }
});
test("complete backup restores attachments with new IDs, preserves order, and never overwrites existing courses", async () => {
  const env = isolated(); const target = isolated(); try {
    const course = env.store.createCourse({ name: "工程力学" }); const lesson = env.store.createLesson({ courseId: course.id, title: "力矩", date: "2026-10-14" }); const image = await upload(request(png, "板书.png"), env.store, lesson.id); const audio = await upload(request(Buffer.from("ID3-audio"), "课堂.mp3"), env.store, lesson.id);
    env.store.updateAttachment(audio.id, { position: 126 }); env.store.updateLesson(lesson.id, { revision: 0, content: [{ id: "one", type: "image", props: { url: `/api/files/${image.id}`, previewWidth: 330 } }] });
    const backup = new Uint8Array(await exportBackup(env.store).arrayBuffer()); const existing = target.store.createCourse({ name: "现有课程" });
    const restored = await restoreBackup(new Request("http://127.0.0.1/api/restore", { method: "POST", body: backup }), target.store);
    assert.deepEqual(restored, { courses: 1, lessons: 1, attachments: 2 }); assert.equal(target.store.course(existing.id).name, "现有课程"); const imported = target.store.library().lessons[0]; assert.notEqual(imported.id, lesson.id);
    const importedFiles = target.store.detail(imported.id).attachments; const importedImage = importedFiles.find(file => file.kind === "image")!; assert.ok(JSON.stringify(imported.content).includes(`/api/files/${importedImage.id}`)); assert.ok(!JSON.stringify(imported.content).includes(`/api/files/${image.id}`)); assert.deepEqual(readFileSync(target.store.filePath(importedImage)), png); assert.equal(importedFiles.find(file => file.kind === "audio")!.position, 126);
  } finally { env.cleanup(); target.cleanup(); }
});
test("malformed and missing-file backups are rejected without altering the knowledge base", async () => {
  const env = isolated(); try { env.store.createCourse({ name: "保留我" }); await assert.rejects(restoreBackup(new Request("http://127.0.0.1/api/restore", { method: "POST", body: "broken" }), env.store)); assert.equal(env.store.library().courses.length, 1);
    const course = { id: randomUUID(), name: "坏备份", color: "#7460aa", description: "", archived: 0, createdAt: new Date().toISOString() }; const lesson = { id: randomUUID(), courseId: course.id, title: "坏备份", date: "2026-10-14", content: [], revision: 0, createdAt: course.createdAt, updatedAt: course.createdAt, visitedAt: null };
    const archive = archiver("zip"); const stream = new PassThrough(); const chunks: Buffer[] = []; stream.on("data", chunk => chunks.push(chunk)); const done = new Promise<void>((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); }); archive.pipe(stream); archive.append(JSON.stringify({ format: "classnote", version: 1, courses: [course], lessons: [lesson], attachments: [{ id: randomUUID(), lessonId: lesson.id, name: "缺失.png", kind: "image", mime: "image/png", size: 100, filename: randomUUID() + ".png", sha256: "0".repeat(64), position: 0, createdAt: course.createdAt }] }), { name: "manifest.json" }); await archive.finalize(); await done;
    await assert.rejects(restoreBackup(new Request("http://127.0.0.1/api/restore", { method: "POST", body: Buffer.concat(chunks) }), env.store), /缺少/); assert.equal(env.store.library().courses.length, 1);
  } finally { env.cleanup(); }
});
