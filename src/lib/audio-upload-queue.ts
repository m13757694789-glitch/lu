import type { Attachment } from "./models.ts";

export type UploadTarget = { lessonId: string; lessonTitle: string; courseId: string };
export type AudioUploadTask = UploadTarget & {
  id: string; name: string; status: "queued" | "uploading" | "completed" | "failed";
  progress: number; error?: string; warning?: string; replacementId?: string;
};
type Entry = AudioUploadTask & { file?: File };
type Transport = (lessonId: string, file: File, progress: (value: number) => void) => Promise<Attachment>;
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
  private emit() { this.snapshot = this.entries.map(({ file: _, ...task }) => ({ ...task })); for (const listener of this.listeners) listener(); }
  hasPending(target?: { lessonId?: string; courseId?: string }) {
    return this.entries.some(task => (task.status === "queued" || task.status === "uploading") && (!target?.lessonId || task.lessonId === target.lessonId) && (!target?.courseId || task.courseId === target.courseId));
  }
  completionVersion(lessonId: string) { return this.completedVersions.get(lessonId) || 0; }
  removedReplacementIds() { return this.removedReplacements; }
  enqueue(target: UploadTarget, file: File, replacementId?: string) {
    const id = crypto.randomUUID();
    this.entries.push({ ...target, id, name: file.name, file, replacementId, status: "queued", progress: 0 });
    this.emit(); void this.drain(); return id;
  }
  retry(id: string) {
    const task = this.entries.find(task => task.id === id);
    if (!task || task.status !== "failed" || !task.file) return;
    task.status = "queued"; task.progress = 0; task.error = undefined;
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
          await this.transport(current.lessonId, current.file!, value => {
            current.progress = Math.max(current.progress, Math.min(99, Math.max(0, Math.round(value)))); this.emit();
          });
          // Replacing must never delete the old recording before the new one is durable.
          if (current.replacementId && this.removeReplacement) {
            try { await this.removeReplacement(current.replacementId); this.removedReplacements.add(current.replacementId); }
            catch { current.warning = "新录音已上传，旧录音未能删除。请回到课堂检查并手动清理。"; }
          }
          current.status = "completed"; current.progress = 100; current.file = undefined;
          this.completedVersions.set(current.lessonId, this.completionVersion(current.lessonId) + 1);
        } catch (error) {
          current.status = "failed"; current.error = error instanceof Error ? error.message : "上传失败，请重试";
        }
        this.emit();
      }
    } finally { this.running = false; }
  }
}
