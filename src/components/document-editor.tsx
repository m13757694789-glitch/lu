"use client";
import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from "react";
import { BlockNoteSchema, createExtension, defaultBlockSpecs, defaultInlineContentSpecs, type PartialBlock } from "@blocknote/core";
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { zh } from "@blocknote/core/locales";
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { getMathSlashMenuItems, locales as mathLocales } from '@blocknote/math-block';
import { inlineMathSpec,mathBlockSpec } from './math-specs';
import { textOf } from "@/lib/models";
import { extractMath, normalizeMathBlocks, parseMathMarkdown } from '@/lib/math-markdown';
import { mathInputRules } from '@/lib/math-input-rules';
import { hasMarkdownTaskList, normalizeTaskListBlocks } from '@/lib/task-lists';
import { hasDiagramFence, prepareDiagramClipboardHTML } from '@/lib/diagram-markdown';
import { diagramCodeBlockSpec, DiagramViewContext } from './diagram-code-block';

const DividerBlock = createReactBlockSpec({ type: "divider", propSchema: {}, content: "none" }, { render: () => <hr className="document-divider" /> });
const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, codeBlock:diagramCodeBlockSpec, mathBlock: mathBlockSpec, divider: DividerBlock() }, inlineContentSpecs:{...defaultInlineContentSpecs,math:inlineMathSpec} });
const normalizeEditorBlocks = (blocks: unknown[]) => normalizeTaskListBlocks(normalizeMathBlocks(blocks));
const strikeShortcut = createExtension({key:'classnote-strike-shortcut',keyboardShortcuts:{'Mod-Shift-x':({editor})=>{editor.toggleStyles({strike:true});return true;}}});
type NativeBlock = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>;
export type Heading = { id: string; text: string; level: number };
export type EditorHandle = {
  insertImage: (file: File) => Promise<void>;
  insertImages: (files: File[], point?: { x: number; y: number }) => Promise<void>;
  parseMarkdown: (text: string) => Promise<unknown[]>;
  append: (blocks: unknown[]) => void;
  replace: (blocks: unknown[]) => void;
  markdown: () => Promise<string>;
  insertFormula: () => void;
};
type Props = { initialContent: unknown[]; readOnly?: boolean; theme: "light" | "dark"; upload?: (file: File) => Promise<string>; onChange?: (content: unknown[], headings: Heading[]) => void; onHeadings?: (headings: Heading[]) => void; onImageOpen?: (url: string) => void };
const DocumentEditor = forwardRef<EditorHandle, Props>(function DocumentEditor({ initialContent, readOnly = false, theme, upload, onChange, onHeadings, onImageOpen }, ref) {
  const selectionRestore = useRef(0);
  const editor = useCreateBlockNote({ schema, extensions:[mathInputRules,strikeShortcut], dictionary: {...zh,math:mathLocales.zh}, initialContent: initialContent.length ? normalizeEditorBlocks(initialContent) as NativeBlock[] : undefined,
    uploadFile: upload,
    pasteHandler: ({event,editor,defaultPasteHandler}) => {
      const text=event.clipboardData?.getData('text/plain')||event.clipboardData?.getData('text/markdown')||'';
      const inSource=editor.transact(tr=>!!tr.selection.$from.parent.type.spec.code);
      if(!inSource&&!event.clipboardData?.types.includes('blocknote/html')){
        const html = !hasDiagramFence(text) && prepareDiagramClipboardHTML(event.clipboardData?.getData('text/html') || '');
        if(html){
          const blocks=normalizeEditorBlocks(editor.tryParseHTMLToBlocks(html));
          editor.pasteHTML(editor.blocksToFullHTML(blocks as NativeBlock[]),true);return true;
        }
      }
      if(!inSource&&!event.clipboardData?.types.includes('blocknote/html')&&(hasDiagramFence(text)||hasMarkdownTaskList(text)||extractMath(text).formulas.length)){
        const blocks=parseMathMarkdown(text,source=>editor.tryParseMarkdownToBlocks(source));
        editor.pasteHTML(editor.blocksToFullHTML(blocks as NativeBlock[]),true);return true;
      }
      return defaultPasteHandler({prioritizeMarkdownOverHTML:true,plainTextAsMarkdown:true});
    },
  });
  const headings = () => { const result: Heading[] = []; const walk = (blocks: typeof editor.document) => { for (const block of blocks) { if (block.type === "heading") result.push({ id: block.id, text: textOf(block.content), level: block.props.level }); if (block.children?.length) walk(block.children); } }; walk(editor.document); return result; };
  const insertImages = async (files: File[], point?: { x: number; y: number }) => {
    if (!upload) return;
    let anchorId = editor.getTextCursorPosition().block.id;
    if (point) {
      const element = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-node-type='blockContainer'][data-id]");
      const target = element?.dataset.id && editor.getBlock(element.dataset.id);
      if (target) anchorId = target.id;
    }
    for (const file of files) {
      const url = await upload(file);
      const target = editor.getBlock(anchorId) || editor.document[editor.document.length - 1];
      const added = editor.insertBlocks([{ type: "image", props: { url, name: file.name, previewWidth: 560 } }], target, "after");
      if (added[0]) { anchorId = added[0].id; editor.setTextCursorPosition(anchorId, "end"); }
    }
  };
  useEffect(() => { onHeadings?.(headings()); }, []);
  useImperativeHandle(ref, () => ({
    async insertImage(file) { await insertImages([file]); },
    insertImages,
    async parseMarkdown(text) {
      return parseMathMarkdown(text,source=>editor.tryParseMarkdownToBlocks(source));
    },
    append(blocks) {
      if (!blocks.length) return;
      const first = editor.document[0];
      const normalized=normalizeEditorBlocks(blocks) as NativeBlock[];
      if (editor.document.length === 1 && first.type === "paragraph" && first.content.length === 0 && first.children.length === 0) editor.replaceBlocks(editor.document, normalized);
      else editor.insertBlocks(normalized, editor.document[editor.document.length - 1], "after");
    },
    replace(blocks) { editor.replaceBlocks(editor.document, blocks.length ? normalizeEditorBlocks(blocks) as NativeBlock[] : [{ type: "paragraph" }]); },
    async markdown() {
      return editor.blocksToMarkdownLossy(editor.document);
    },
    insertFormula() { getMathSlashMenuItems(editor)[0]?.onItemClick(); },
  }));
  return <div className="document-editor" onKeyDownCapture={event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !['a','c'].includes(event.key.toLowerCase())) return;
    const target=event.target as HTMLElement;if(target.closest('input,textarea,select'))return;
    const root=event.currentTarget,scroller=root.closest<HTMLElement>('.document-scroll');if(!scroller)return;
    const top=scroller.scrollTop,left=scroller.scrollLeft,token=++selectionRestore.current;
    // Preserve native editor/table selection and copy. Only suppress their incidental viewport movement.
    const restore=()=>{if(selectionRestore.current===token&&root.isConnected&&scroller.isConnected){scroller.scrollTo({top,left,behavior:'instant'});}};
    queueMicrotask(restore);setTimeout(restore,0);setTimeout(restore,32);
  }} onDoubleClick={event => { const element = event.target; if (element instanceof HTMLImageElement) onImageOpen?.(element.src); }} onClick={event => { const element = event.target; if (readOnly && element instanceof HTMLImageElement) onImageOpen?.(element.src); }}><DiagramViewContext.Provider value={{theme,readOnly}}><BlockNoteView editor={editor} editable={!readOnly} theme={theme} slashMenu={false} onChange={() => { const outline = headings(); onChange?.(editor.document, outline); onHeadings?.(outline); }}><SuggestionMenuController triggerCharacter="/" getItems={async query=>filterSuggestionItems([...getDefaultReactSlashMenuItems(editor),...getMathSlashMenuItems(editor)],query)} /></BlockNoteView></DiagramViewContext.Provider></div>;
});
export default memo(DocumentEditor);
