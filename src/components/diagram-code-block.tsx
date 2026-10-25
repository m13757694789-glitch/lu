"use client";
import { createContext, useContext, useEffect, useState } from 'react';
import { defaultBlockSpecs, plainContentToString } from '@blocknote/core';
import { createReactBlockSpec, type ReactCustomBlockRenderProps } from '@blocknote/react';
import { diagramKind } from '@/lib/diagram-markdown';
import { diagramFrameHTML, renderDiagram, type DiagramResult, type DiagramTheme } from '@/lib/diagram-renderer';

export const DiagramViewContext = createContext<{theme:DiagramTheme;readOnly:boolean}>({theme:'dark',readOnly:false});
const native = defaultBlockSpecs.codeBlock;

function CodeBlock({block,editor,contentRef}: ReactCustomBlockRenderProps<typeof native.config>) {
  const kind = diagramKind(block.props.language);
  const source = plainContentToString(block.content);
  const {theme,readOnly} = useContext(DiagramViewContext);
  const [showSource,setShowSource] = useState(false);
  const [result,setResult] = useState<DiagramResult | null>(null);
  const [error,setError] = useState('');
  const [zoom,setZoom] = useState('fit');
  useEffect(() => {
    if (!kind) return;
    let active = true;
    const timer = setTimeout(() => {
      setError('');setResult(null);
      void renderDiagram(kind,source,theme).then(value => {if(active)setResult(value);}).catch(reason => {if(active)setError(reason instanceof Error ? reason.message.slice(0,500) : '图形无法显示，请检查源码。');});
    },200);
    return () => {active=false;clearTimeout(timer);};
  },[kind,source,theme]);
  if (!kind) return <pre><code ref={contentRef} /></pre>;
  return <div className="diagram-block" data-diagram-kind={kind}>
    <div className="diagram-toolbar" contentEditable={false}>
      <span>{kind === 'mermaid' ? 'Mermaid 图表' : 'SVG 示意图'}</span>
      {!showSource && result && <select aria-label="图形缩放" value={zoom} onChange={event=>setZoom(event.target.value)}><option value="fit">适合宽度</option><option value="1">100%</option><option value="1.5">150%</option></select>}
      <button type="button" aria-pressed={showSource} onMouseDown={event=>event.preventDefault()} onClick={()=>setShowSource(value=>!value)}>{showSource ? '预览图形' : '查看源码'}</button>
    </div>
    {error && <div className="diagram-error" role="alert" contentEditable={false}>图形未能显示：{error}<small>原始源码保留在下方，可继续修改；其他笔记内容不受影响。</small></div>}
    {!showSource && !error && <div className="diagram-preview" contentEditable={false} tabIndex={0} aria-label="图形预览，可滚动">
      {result ? <iframe className="diagram-frame" sandbox="" referrerPolicy="no-referrer" title={`${kind === 'mermaid' ? 'Mermaid' : 'SVG'} 图形预览`} srcDoc={diagramFrameHTML(result,theme)} style={{width:zoom === 'fit' ? `min(100%, ${result.width}px)` : `${result.width*Number(zoom)}px`,aspectRatio:`${result.width} / ${result.height}`}} /> : <span className="diagram-loading" role="status">正在生成图形…</span>}
    </div>}
    {(showSource || error) && <div contentEditable={false}><textarea className="diagram-source" aria-label={`${kind === 'mermaid' ? 'Mermaid' : 'SVG'} 源码`} value={source} readOnly={readOnly} rows={Math.max(5,Math.min(18,source.split('\n').length+1))} spellCheck={false} onChange={event=>{if(!readOnly)editor.updateBlock(block,{content:event.target.value});}} /></div>}
    <pre hidden aria-hidden="true" className="diagram-model-source"><code ref={contentRef} /></pre>
  </div>;
}

export const diagramCodeBlockSpec = createReactBlockSpec(native.config,{
  meta:native.implementation.meta,
  parse:native.implementation.parse,
  parseContent:native.implementation.parseContent,
  render:CodeBlock,
},native.extensions)();
// Keep the React node view, but serialize clipboard HTML as native plain source.
// Previews, iframes and toolbar text must never enter pasted/exported content.
const reactRender = diagramCodeBlockSpec.implementation.render;
diagramCodeBlockSpec.implementation.render = function(block,editor) {
  return this.renderType === 'nodeView' && diagramKind(block.props.language) ? reactRender.call(this,block,editor) : native.implementation.render.call(this,block,editor);
};
diagramCodeBlockSpec.implementation.toExternalHTML = native.implementation.toExternalHTML;
