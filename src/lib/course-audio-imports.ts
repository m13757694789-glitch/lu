import type { LessonDetail } from './models.ts';
import type { AudioUploadQueue } from './audio-upload-queue.ts';
import { UploadSourceError, verifyUploadSource } from './upload-source.ts';

export const audioFileAccept = '.mp3,.m4a,.wav,.ogg,.oga,.opus,.aac,.flac,.webm';
export const isAudioRecording = (file: Pick<File, 'name'>) => /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|webm)$/i.test(file.name);
export const recordingTitle = (name: string) => name.replace(/\.[^.]+$/, '').trim().slice(0, 200) || '课堂录音';
export type RecordingLessonInput = { id: string; courseId: string; title: string; date: string };
export type CourseAudioImportTask = RecordingLessonInput & {
  name: string; courseName: string; status: 'queued' | 'creating' | 'failed'; error?: string; needsReselect?: boolean;
};
type Entry = CourseAudioImportTask & { file: File };
const emptyTasks: readonly CourseAudioImportTask[] = [];

// File selection and record creation survive navigation between notes.
export class CourseAudioImports {
  private entries: Entry[] = [];
  private snapshot: readonly CourseAudioImportTask[] = emptyTasks;
  private listeners = new Set<() => void>();
  private createdListeners = new Set<(lesson: LessonDetail) => void>();
  private running = false;
  private create: (input: RecordingLessonInput) => Promise<LessonDetail>;
  private uploads: AudioUploadQueue;
  constructor(create: (input: RecordingLessonInput) => Promise<LessonDetail>, uploads: AudioUploadQueue) { this.create = create; this.uploads = uploads; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onCreated = (listener: (lesson: LessonDetail) => void) => { this.createdListeners.add(listener); return () => { this.createdListeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => emptyTasks;
  private emit() { this.snapshot = this.entries.map(({ file: _, ...task }) => ({ ...task })); for (const listener of this.listeners) listener(); }
  hasPending(target?: { courseId?: string; lessonId?: string }) {
    return this.entries.some(task => task.status !== 'failed' && (!target?.courseId || task.courseId === target.courseId) && (!target?.lessonId || task.id === target.lessonId));
  }
  enqueue(course: { id: string; name: string }, file: File, date: string) {
    const id = crypto.randomUUID();
    this.entries.push({ id, courseId: course.id, courseName: course.name, title: recordingTitle(file.name), date, name: file.name, file, status: 'queued' });
    this.emit(); void this.drain(); return id;
  }
  retry(id: string) {
    const task = this.entries.find(task => task.id === id);
    if (!task || task.status !== 'failed' || task.needsReselect) return;
    task.status = 'queued'; task.error = undefined; this.emit(); void this.drain();
  }
  reselect(id: string, file: File) {
    const task = this.entries.find(task => task.id === id);
    if (!task || task.status !== 'failed') return;
    task.file = file; task.name = file.name; task.status = 'queued'; task.error = undefined; task.needsReselect = false;
    this.emit(); void this.drain();
  }
  dismiss(id: string) { this.entries = this.entries.filter(task => task.id !== id || task.status !== 'failed'); this.emit(); }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.entries.find(task => task.status === 'queued'); task; task = this.entries.find(task => task.status === 'queued')) {
        task.status = 'creating'; this.emit();
        try {
          if (!isAudioRecording(task.file)) throw new UploadSourceError('请选择 MP3、M4A、WAV 等支持的录音文件。');
          if (task.file.name.length > 240 || task.file.size > 8 * 1024 ** 3) throw new UploadSourceError('文件名请不超过 240 个字符，单份录音请不超过 8 GB。');
          await verifyUploadSource(task.file);
          const lesson = await this.create({ id: task.id, courseId: task.courseId, title: task.title, date: task.date });
          this.uploads.enqueue({ lessonId: lesson.id, lessonTitle: lesson.title, courseId: lesson.courseId }, task.file);
          this.entries = this.entries.filter(entry => entry !== task);
          for (const listener of this.createdListeners) listener(lesson);
        } catch (error) {
          task.status = 'failed'; task.error = error instanceof Error ? error.message : '新建课堂失败，请重试';
          task.needsReselect = error instanceof UploadSourceError;
        }
        this.emit();
      }
    } finally { this.running = false; }
  }
}
