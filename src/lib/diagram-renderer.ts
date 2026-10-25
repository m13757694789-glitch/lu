import createDOMPurify from 'dompurify';
import { validateMermaidSource, type DiagramKind } from './diagram-markdown';

export type DiagramTheme = 'light' | 'dark';
export type DiagramResult = { html: string; width: number; height: number };
const SVG_NS = 'http://www.w3.org/2000/svg';
const cache = new Map<string, DiagramResult>();
let queue: Promise<unknown> = Promise.resolve();
let mermaidModule: Promise<typeof import('mermaid')> | undefined;

export function sanitizeDiagramSVG(source: string, generated = false): DiagramResult {
  if (new TextEncoder().encode(source).byteLength > 200_000) throw new Error('SVG 超过 200 KB，请简化图形；源码已保留。');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG 不支持文档类型或实体声明。');
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg' || doc.documentElement.namespaceURI !== SVG_NS) throw new Error('SVG 格式不正确，请检查标签是否闭合及 xmlns 声明。');
  if (doc.querySelectorAll('*').length > 2500) throw new Error('SVG 元素过多，请简化图形。');
  const purifier = createDOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrValue.includes('\\') || data.attrName === 'xml:base') data.keepAttr = false;
    if (/^(?:href|xlink:href|src)$/i.test(data.attrName) && !/^#[\w.:-]+$/.test(data.attrValue)) data.keepAttr = false;
    if (/url\s*\(/i.test(data.attrValue) && !/^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(data.attrValue) && data.attrName !== 'style') data.keepAttr = false;
  });
  const clean = purifier.sanitize(source, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ['script','foreignObject','image','feImage','filter','animate','animateMotion','animateTransform','set','discard','a', ...(generated ? [] : ['style'])],
    FORBID_ATTR: generated ? [] : ['style'],
    ALLOW_DATA_ATTR: false,
    SAFE_FOR_XML: true,
  });
  const sanitized = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const svg = sanitized.documentElement;
  if (sanitized.querySelector('parsererror') || svg.localName !== 'svg') throw new Error('SVG 安全清理后无法显示；源码已保留。');
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length !== 4) throw new Error('SVG 的 viewBox 需要四个有效数字。');
  const width = box?.length === 4 ? box[2] : parseFloat(svg.getAttribute('width') || '300');
  const height = box?.length === 4 ? box[3] : parseFloat(svg.getAttribute('height') || '150');
  if (![width,height,...(box || [])].every(Number.isFinite) || width <= 0 || height <= 0 || width > 1e7 || height > 1e7) throw new Error('SVG 的 viewBox 或尺寸无效。');
  if (!box) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width','100%');svg.setAttribute('height','100%');
  return { html: new XMLSerializer().serializeToString(svg), width, height };
}

// The sandbox is a second boundary: no scripts, external images, fonts, frames,
// or connections, even if a future diagram format adds new resource attributes.
export function diagramFrameHTML(result: DiagramResult, theme: DiagramTheme) {
  const color = theme === 'dark' ? '#d6d4cf' : '#303235';
  const background = theme === 'dark' ? '#202223' : '#f7f7f5';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:${background};color:${color};color-scheme:${theme};font-family:'Microsoft YaHei',system-ui,sans-serif}svg{display:block;width:100%;height:auto}body>svg{background:${background}!important}</style></head><body>${result.html}</body></html>`;
}

export async function renderDiagram(kind: DiagramKind, source: string, theme: DiagramTheme): Promise<DiagramResult> {
  if (!source.trim()) throw new Error('请在源码中填写图形内容。');
  const key = `${kind}:${theme}:${source}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key);cache.set(key,hit);return hit; }
  let result: DiagramResult;
  if (kind === 'svg') result = sanitizeDiagramSVG(source);
  else {
    validateMermaidSource(source);
    const job = queue.then(async () => {
      const {default:mermaid} = await (mermaidModule ||= import('mermaid'));
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',htmlLabels:false,suppressErrorRendering:true,maxTextSize:50_000,maxEdges:500,theme:theme === 'dark' ? 'dark' : 'default',fontFamily:'Microsoft YaHei, system-ui, sans-serif'});
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;width:900px;pointer-events:none';
      document.body.appendChild(container);
      try {
        const rendered = await mermaid.render('cnDiagram'+crypto.randomUUID().replaceAll('-',''),source,container);
        return sanitizeDiagramSVG(rendered.svg,true);
      } finally { container.remove(); }
    });
    queue = job.catch(() => undefined);
    result = await job;
  }
  cache.set(key,result);
  while (cache.size > 20) cache.delete(cache.keys().next().value!);
  return result;
}
