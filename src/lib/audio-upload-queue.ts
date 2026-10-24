import type { Attachment } from "./models.ts";
import type { TransferObserver, UploadTransfer } from "./upload-progress.ts";
import { UploadSourceError, uploadSourceSize } from './upload-source.ts';

export type UploadTarget = { lessonId: string; lessonTitle: string; courseId: string };
export type AudioUploadTask = UploadTarget & {
  id: string; name: string; status: "queued" | "uploading" | "completed" | "failed";
  progress: number; error?: string; warning?: string; replacementId?: string; transfer?: UploadTransfer; needsReselect?: boolean;
};
type Entry = AudioUploadTask & { file?: File; sourceSize: number };
type Transport = (lessonId: string, file: File, progress: (value: number) => void, observe: TransferObserver) => Promise<Attachment>;
const emptyTasks: readonly AudioUploadTask[] = [];

// Owned by the workspace, not an individual note. File objects never go into React or localStorage.
export class AudioUploadQueue {
  private entries: Entry[] = [];
  private snapshot: readonly AudioUploadTask[] = emptyTasks;
  private listeners = new Set<() => void>();
  private running = false;
  private completedVersions = new Map<string, number>();
  private removedReplacements = new Set<string>();
  constructor(privateTransport: Transport, removeReplacement?: (id: string) => Promise<void>) {
    this.transport = privateTransport; this.removeReplacement = removeReplacement;
  }
  private transport: Transport;
  private removeReplacement?: (id: string) => Promise<void>;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => emptyTasks;
  private emit() { this.snapshot = this.entries.map(({ file: _, sourceSize: __, ...task }) => ({ ...task })); for (const listener of this.listeners) listener(); }
  hasPending(target?: { lessonId?: string; courseId?: string }) {
    return this.entries.some(task => (task.status === "queued" || task.status === "uploading") && (!target?.lessonId || task.lessonId === target.lessonId) && (!target?.courseId || task.courseId === target.courseId));
  }
  completionVersion(lessonId: string) { return this.completedVersions.get(lessonId) || 0; }
  removedReplacementIds() { return this.removedReplacements; }
  enqueue(target: UploadTarget, file: File, replacementId?: string) {
    const id = crypto.randomUUID();
    this.entries.push({ ...target, id, name: file.name, file, sourceSize:file.size, replacementId, status: "queued", progress: 0 });
    this.emit(); void this.drain(); return id;
  }
  retry(id: string) {
    const task = this.entries.find(task => task.id === id);
    if (!task || task.status !== "failed" || !task.file || task.needsReselect) return;
    task.status = "queued"; task.progress = 0; task.error = undefined; task.transfer = undefined;
    this.emit(); void this.drain();
  }
  reselect(id: string, file: File) {
    const task = this.entries.find(task => task.id === id);
    if (!task || task.status !== 'failed') return;
    task.file = file; task.sourceSize = file.size; task.name = file.name;
    task.status = 'queued'; task.progress = 0; task.error = undefined; task.needsReselect = false; task.transfer = undefined;
    this.emit(); void this.drain();
  }
  dismiss(id: string) { this.entries = this.entries.filter(task => task.id !== id || task.status === "queued" || task.status === "uploading"); this.emit(); }
  clearCompleted() { this.entries = this.entries.filter(task => task.status !== "completed"); this.emit(); }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.entries.find(task => task.status === "queued"); task; task = this.entries.find(task => task.status === "queued")) {
        const current = task; current.status = "uploading"; this.emit();
        try {
          if (uploadSourceSize(current.file!) !== current.sourceSize) throw new UploadSourceError('原文件在等待上传时发生了变化，请重新选择文件后上传。');
          await this.transport(current.lessonId, current.file!, value => {
            current.progress = Math.max(current.progress, Math.min(99, Math.max(0, Math.round(value)))); this.emit();
          }, transfer => { current.transfer = transfer; this.emit(); });
          // Replacing must never delete the old recording before the new one is durable.
          if (current.replacementId && this.removeReplacement) {
            try { await this.removeReplacement(current.replacementId); this.removedReplacements.add(current.replacementId); }
            catch { current.warning = "新录音已上传，旧录音未能删除。请回到课堂检查并手动清理。"; }
          }
          current.status = "completed"; current.progress = 100; current.file = undefined;
          this.completedVersions.set(current.lessonId, this.completionVersion(current.lessonId) + 1);
        } catch (error) {
          current.status = "failed"; current.error = error instanceof Error ? error.message : "上传失败，请重试";
          current.needsReselect = error instanceof UploadSourceError;
        }
        this.emit();
      }
    } finally { this.running = false; }
  }
}
