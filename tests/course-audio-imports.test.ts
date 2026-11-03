import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioUploadQueue } from '../src/lib/audio-upload-queue.ts';
import { CourseAudioImports, recordingTitle, type RecordingLessonInput } from '../src/lib/course-audio-imports.ts';
import { Store } from '../src/lib/storage.ts';
import { CloudStore } from '../src/lib/cloud-store.ts';
import type { Attachment, LessonDetail } from '../src/lib/models.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

const file = (name: string) => new File(['audio'], name);
const lesson = (input: RecordingLessonInput) => ({ ...input, content: [], attachments: [], revision: 0, visitedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as LessonDetail);
async function settled(imports: CourseAudioImports, uploads: AudioUploadQueue) {
  if (!imports.hasPending() && !uploads.hasPending()) return;
  await new Promise<void>(resolve => {
    const check = () => { if (!imports.hasPending() && !uploads.hasPending()) { stopImports(); stopUploads(); resolve(); } };
    const stopImports = imports.subscribe(check), stopUploads = uploads.subscribe(check);
    check();
  });
}

test('one recording creates one named lesson, in order, independently of other courses and uploads', async () => {
  const created: RecordingLessonInput[] = [], uploaded: string[] = [], visible: string[] = [];
  let release!: () => void;
  const uploads = new AudioUploadQueue(async (id, source) => {
    uploaded.push(id + '/' + source.name);
    if (uploaded.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return { id: crypto.randomUUID() } as Attachment;
  });
  const imports = new CourseAudioImports(async input => { created.push(input); return lesson(input); }, uploads);
  imports.onCreated(row => visible.push(row.id));
  const a = { id: crypto.randomUUID(), name: '力学' }, b = { id: crypto.randomUUID(), name: '电子' };
  const ids = [imports.enqueue(a, file('9.15 力学1.m4a'), '2026-11-03'), imports.enqueue(a, file('第二份.WAV'), '2026-11-03'), imports.enqueue(b, file('电子.mp3'), '2026-11-03')];
  assert(imports.hasPending({ courseId: a.id }));
  assert(!imports.hasPending({ courseId: 'unrelated' }));
  assert(!JSON.stringify(imports.getSnapshot()).includes('"file":'));
  while (created.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(created.map(row => [row.id, row.title, row.courseId]), [[ids[0], '9.15 力学1', a.id], [ids[1], '第二份', a.id], [ids[2], '电子', b.id]]);
  assert.equal(uploaded.length, 1, 'record creation continues while an earlier upload is waiting');
  release(); await settled(imports, uploads);
  assert.deepEqual(uploaded, [ids[0] + '/9.15 力学1.m4a', ids[1] + '/第二份.WAV', ids[2] + '/电子.mp3']);
  assert.deepEqual(visible, ids); assert.equal(imports.getSnapshot().length, 0);
});

test('empty or unsupported files do not create empty lessons, and reselect keeps the original import identity', async () => {
  const created: RecordingLessonInput[] = [];
  const uploads = new AudioUploadQueue(async () => ({ id: crypto.randomUUID() } as Attachment));
  const imports = new CourseAudioImports(async input => { created.push(input); return lesson(input); }, uploads);
  const course = { id: crypto.randomUUID(), name: 'A' };
  const empty = imports.enqueue(course, new File([], 'empty.m4a'), '2026-11-03');
  imports.enqueue(course, file('image.png'), '2026-11-03');
  await settled(imports, uploads);
  assert.equal(created.length, 0); assert(imports.getSnapshot().every(task => task.needsReselect));
  imports.retry(empty); assert.equal(imports.hasPending(), false);
  imports.reselect(empty, file('readable.m4a')); await settled(imports, uploads);
  assert.equal(created[0].id, empty); assert.equal(created[0].title, 'empty');
  assert.equal(uploads.getSnapshot()[0].lessonId, empty);
});

test('a lost creation response can retry without duplicating the lesson or overwriting later edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'classnote-import-')), store = new Store(directory);
  try {
    const course = store.createCourse({ name: '力学' }); let fail = true;
    const uploads = new AudioUploadQueue(async () => ({ id: crypto.randomUUID() } as Attachment));
    const imports = new CourseAudioImports(async input => { const row = store.createLesson(input); if (fail) { fail = false; throw new Error('response lost'); } return row; }, uploads);
    const id = imports.enqueue(course, file('第一节.m4a'), '2026-11-03');
    await settled(imports, uploads); assert.equal(imports.getSnapshot()[0].status, 'failed');
    store.updateLesson(id, { revision: 0, title: '用户已重命名', content: [{ id: 'keep', type: 'paragraph', content: '保留内容' }] });
    imports.retry(id); await settled(imports, uploads);
    assert.equal(store.library().lessons.length, 1); assert.equal(store.lesson(id).revision, 1);
    assert.equal(store.lesson(id).title, '用户已重命名'); assert.equal(uploads.getSnapshot()[0].lessonTitle, '用户已重命名');
    const other = store.createCourse({ name: '另一门' });
    assert.throws(() => store.createLesson({ id, courseId: other.id, title: '错误课程', date: '2026-11-03' }), /另一门课程/);
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cloud creation reuses the same owned record only for the original course', async () => {
  const id = crypto.randomUUID(), courseId = crypto.randomUUID(), other = crypto.randomUUID();
  const original = { ...lesson({ id, courseId, title: '已编辑的标题', date: '2026-11-03' }), revision: 3 };
  const client = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate id' } }) }) }) }) } as unknown as SupabaseClient;
  const store = new CloudStore(client, 'owner');
  store.course = async key => ({ id: key } as Awaited<ReturnType<typeof store.course>>);
  store.detail = async () => original;
  assert.equal((await store.createLesson({ id, courseId, title: '最初的标题', date: '2026-11-03' })).revision, 3);
  await assert.rejects(store.createLesson({ id, courseId: other, title: '错误课程', date: '2026-11-03' }), /另一门课程/);
});

test('recording titles retain Chinese names and dates and fit the existing title limit', () => {
  assert.equal(recordingTitle('10.20电子6.m4a'), '10.20电子6');
  assert.equal(recordingTitle('  力学  .WAV'), '力学');
  assert.equal(recordingTitle('.m4a'), '课堂录音');
  assert.equal(recordingTitle('课'.repeat(240) + '.mp3').length, 200);
});
