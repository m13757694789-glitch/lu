"use client";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { zh } from "@blocknote/core/locales";
import { createReactBlockSpec, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import katex from "katex";
import { textOf } from "@/lib/models";

const MathBlock = createReactBlockSpec({ type: "math", propSchema: { formula: { default: "" } }, content: "none" }, {
  render: ({ block, editor }) => <div className="formula-block"><div dangerouslySetInnerHTML={{ __html: katex.renderToString(block.props.formula || "\\text{在下方输入 LaTeX 公式}", { displayMode: true, throwOnError: false, trust: false }) }} />{editor.isEditable && <textarea aria-label="LaTeX公式" placeholder="例如 M = F \\cdot d" value={block.props.formula} onChange={event => editor.updateBlock(block, { props: { formula: event.target.value } })} />}</div>,
});
const DividerBlock = createReactBlockSpec({ type: "divider", propSchema: {}, content: "none" }, { render: () => <hr className="document-divider" /> });
const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, math: MathBlock(), divider: DividerBlock() } });
type NativeBlock = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>;
export type Heading = { id: string; text: string; level: number };
export type EditorHandle = {
  insertImage: (file: File) => Promise<void>;
  parseMarkdown: (text: string) => Promise<unknown[]>;
  append: (blocks: unknown[]) => void;
  replace: (blocks: unknown[]) => void;
  markdown: () => Promise<string>;
  insertFormula: () => void;
};
type Props = { initialContent: unknown[]; readOnly?: boolean; theme: "light" | "dark"; upload?: (file: File) => Promise<string>; onChange?: (content: unknown[], headings: Heading[]) => void; onHeadings?: (headings: Heading[]) => void; onImageOpen?: (url: string) => void };
const DocumentEditor = forwardRef<EditorHandle, Props>(function DocumentEditor({ initialContent, readOnly = false, theme, upload, onChange, onHeadings, onImageOpen }, ref) {
  const editor = useCreateBlockNote({ schema, dictionary: zh, initialContent: initialContent.length ? initialContent as NativeBlock[] : undefined,
    uploadFile: upload,
    pasteHandler: ({ defaultPasteHandler }) => defaultPasteHandler({ prioritizeMarkdownOverHTML: true, plainTextAsMarkdown: true }),
  });
  const headings = () => { const result: Heading[] = []; const walk = (blocks: typeof editor.document) => { for (const block of blocks) { if (block.type === "heading") result.push({ id: block.id, text: textOf(block.content), level: block.props.level }); if (block.children?.length) walk(block.children); } }; walk(editor.document); return result; };
  useEffect(() => { onHeadings?.(headings()); }, []);
  useImperativeHandle(ref, () => ({
    async insertImage(file) {
      if (!upload) return;
      // Capture insertion target before awaiting the upload; choosing a file must not move it to the end.
      const anchor = editor.getTextCursorPosition().block;
      const url = await upload(file); const added = editor.insertBlocks([{ type: "image", props: { url, name: file.name, previewWidth: 560 } }], anchor, "after");
      if (added[0]) editor.setTextCursorPosition(added[0], "end");
    },
    async parseMarkdown(text) {
      // External images become links; importing a note never silently contacts a third-party image host.
      const safe = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "[$1（外部图片，需另行上传）]($2)");
      const parts = safe.split(/(\$\$[\s\S]*?\$\$)/g); const blocks: NativeBlock[] = [];
      for (const part of parts) {
        if (/^\$\$[\s\S]*\$\$$/.test(part)) blocks.push({ type: "math", props: { formula: part.slice(2, -2).trim() } });
        else if (part.trim()) blocks.push(...await editor.tryParseMarkdownToBlocks(part));
      }
      return blocks;
    },
    append(blocks) {
      if (!blocks.length) return;
      const first = editor.document[0];
      if (editor.document.length === 1 && first.type === "paragraph" && first.content.length === 0 && first.children.length === 0) editor.replaceBlocks(editor.document, blocks as NativeBlock[]);
      else editor.insertBlocks(blocks as NativeBlock[], editor.document[editor.document.length - 1], "after");
    },
    replace(blocks) { editor.replaceBlocks(editor.document, blocks.length ? blocks as NativeBlock[] : [{ type: "paragraph" }]); },
    async markdown() {
      // Preserve custom math/divider blocks explicitly because the generic lossy exporter cannot represent them.
      const parts: string[] = [];
      for (const block of editor.document) { if (block.type === "math") parts.push(`$$\n${block.props.formula}\n$$`); else if (block.type === "divider") parts.push("---"); else parts.push(await editor.blocksToMarkdownLossy([block])); }
      return parts.join("\n\n");
    },
    insertFormula() { const anchor = editor.getTextCursorPosition().block; editor.insertBlocks([{ type: "math", props: { formula: "M = F \\cdot d" } }], anchor, "after"); },
  }));
  return <div className="document-editor" onDoubleClick={event => { const element = event.target; if (element instanceof HTMLImageElement) onImageOpen?.(element.src); }} onClick={event => { const element = event.target; if (readOnly && element instanceof HTMLImageElement) onImageOpen?.(element.src); }}><BlockNoteView editor={editor} editable={!readOnly} theme={theme} onChange={() => { const outline = headings(); onChange?.(editor.document, outline); onHeadings?.(outline); }} /></div>;
});
export default DocumentEditor;
