export type Course = { id: string; name: string; color: string; description: string; archived: number; createdAt: string };
export type Lesson = { id: string; courseId: string; title: string; date: string; content: unknown[]; revision: number; createdAt: string; updatedAt: string; visitedAt: string | null };
export type Attachment = { id: string; lessonId: string; name: string; kind: "audio" | "image"; mime: string; size: number; filename: string; sha256: string; position: number; createdAt: string };
export type Library = { courses: Course[]; lessons: Lesson[]; settings: Record<string, unknown> };
export type LessonDetail = Lesson & { attachments: Attachment[] };
export type SaveState = "saved" | "saving" | "dirty" | "error";
export function mapAttachmentUrls(content: unknown[], transform: (id: string) => string): unknown[] {
  const result = structuredClone(content);
  const walk = (blocks: unknown[]) => {
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as { props?: Record<string, unknown>; children?: unknown[] };
      if (typeof block.props?.url === "string") {
        const match = /^\/api\/files\/([\da-f-]{36})(\?.*)?$/i.exec(block.props.url);
        if (match) block.props.url = `/api/files/${transform(match[1])}${match[2] || ""}`;
      }
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(result); return result;
}
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.text === "string") return object.text;
    return [object.content, object.children, object.rows, object.cells].map(textOf).join(" ");
  }
  return "";
}
