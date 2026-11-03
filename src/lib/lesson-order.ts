import type { Lesson } from './models.ts';

export type LessonSortMode = 'manual' | 'oldest' | 'newest';
export const lessonOrderKey = (courseId: string) => `lessonOrder:${courseId}`;
export const lessonSortMode = (value: unknown): LessonSortMode => value === 'oldest' || value === 'newest' ? value : 'manual';
export const lessonDragType = 'application/x-classnote-lesson';
type OrderedLesson = Pick<Lesson, 'id' | 'courseId' | 'createdAt'>;

export function orderedLessons<T extends OrderedLesson>(lessons: readonly T[], courseId: string, settings: Record<string, unknown>): T[] {
  const mode = lessonSortMode(settings.lessonSortMode);
  const sorted = lessons.filter(lesson => lesson.courseId === courseId).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (mode === 'newest') return sorted.reverse();
  const saved = settings[lessonOrderKey(courseId)];
  if (mode !== 'manual' || !Array.isArray(saved)) return sorted;
  const rank = new Map<string, number>();
  for (const id of saved) if (typeof id === 'string' && !rank.has(id)) rank.set(id,rank.size);
  // Deleted/moved IDs are ignored; newly created records follow the saved sequence.
  return sorted.sort((a,b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function reorderedLessonIds(lessons: readonly OrderedLesson[], sourceId: string, targetId: string, edge: 'before' | 'after'): string[] | null {
  const source = lessons.find(lesson => lesson.id === sourceId), target = lessons.find(lesson => lesson.id === targetId);
  if (!source || !target || source.id === target.id || source.courseId !== target.courseId) return null;
  const ids = lessons.filter(lesson => lesson.courseId === source.courseId && lesson.id !== sourceId).map(lesson => lesson.id);
  ids.splice(ids.indexOf(targetId) + (edge === 'after' ? 1 : 0), 0, sourceId);
  return ids;
}

type OrderSnapshot = { settings: Record<string, unknown>; busy: boolean; error: string };
const emptySnapshot: OrderSnapshot = { settings: {}, busy: false, error: '' };
const orderSetting = (key: string) => key === 'lessonSortMode' || key.startsWith('lessonOrder:');

// Apply moves immediately, serialize saves, and coalesce repeated moves while a request is in flight.
export class LessonOrderQueue {
  private current: Record<string, unknown> = {};
  private confirmed: Record<string, unknown> = {};
  private pending: Record<string, unknown> = {};
  private running = false;
  private error = '';
  private snapshot = emptySnapshot;
  private listeners = new Set<() => void>();
  private save: (patch: Record<string, unknown>) => Promise<unknown>;
  constructor(save: (patch: Record<string, unknown>) => Promise<unknown>) { this.save = save; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => emptySnapshot;
  hasPending = () => this.running || Object.keys(this.pending).length > 0;
  private emit() { this.snapshot = { settings: this.current, busy: this.hasPending(), error: this.error }; for (const listener of this.listeners) listener(); }
  load(settings: Record<string, unknown>) {
    if (this.hasPending()) return;
    this.current = Object.fromEntries(Object.entries(settings).filter(([key]) => orderSetting(key)));
    this.confirmed = { ...this.current }; this.error = ''; this.emit();
  }
  enqueue(patch: Record<string, unknown>) {
    const selected = structuredClone(Object.fromEntries(Object.entries(patch).filter(([key]) => orderSetting(key))));
    if (!Object.keys(selected).length) return;
    this.current = { ...this.current, ...selected }; this.pending = { ...this.pending, ...selected }; this.error = '';
    this.emit(); void this.drain();
  }
  private async drain() {
    if (this.running) return;
    this.running = true; this.emit();
    try {
      while (Object.keys(this.pending).length) {
        const patch = this.pending; this.pending = {};
        try { await this.save(patch); this.confirmed = { ...this.confirmed, ...patch }; this.error = ''; }
        catch {
          const restored = { ...this.current }; let rolledBack = false;
          for (const key of Object.keys(patch)) {
            if (Object.hasOwn(this.pending,key)) continue;
            if (Object.hasOwn(this.confirmed,key)) restored[key] = this.confirmed[key]; else delete restored[key];
            rolledBack = true;
          }
          this.current = restored;
          if (rolledBack) this.error = '课堂顺序未能保存，已恢复上次保存的顺序，请重试。';
        }
        this.emit();
      }
    } finally { this.running = false; this.emit(); }
  }
}
