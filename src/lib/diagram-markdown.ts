export type DiagramKind = 'mermaid' | 'svg';
export const diagramKind = (language: string): DiagramKind | null => {
  const value = language.trim().toLowerCase();
  return value === 'mermaid' || value === 'svg' ? value : null;
};

export const hasDiagramFence = (text: string) => /^ {0,3}(?:`{3,}|~{3,})(?:mermaid|svg)(?=\s|$)/im.test(text);

// Check before Mermaid creates its measuring DOM: source cannot request remote
// images or CSS resources, or change the site's rendering/security settings.
export function validateMermaidSource(source: string) {
  if (new TextEncoder().encode(source).byteLength > 50_000) throw new Error('Mermaid 超过 50 KB，请拆分为较小的图表。');
  if (/%%\s*\{|^\s*---|\bimg\s*:|<\s*(?:img|image|script|foreignObject)\b|\burl\s*\(|(?:^|\n)\s*(?:classDef|style|linkStyle)\b[^\n]*\\/im.test(source)) throw new Error('不支持 Mermaid 配置指令、HTML、外部资源或 CSS 转义；请使用静态图表语法。');
}

// A browser selection can provide rich HTML with language markers while its
// plain-text counterpart has no fences. Preserve the <code> source and remove
// copy buttons/wrappers before letting the existing HTML parser handle the note.
export function prepareDiagramClipboardHTML(html: string): string | null {
  if (!html || !/\b(?:mermaid|svg)\b/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let found = false;
  for (const pre of doc.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const language = code.getAttribute('data-language') || code.className.split(/\s+/).find(value => value.startsWith('language-'))?.slice(9) || '';
    if (!diagramKind(language)) continue;
    const clean = doc.createElement('code');
    clean.dataset.language = language;
    clean.className = `language-${language}`;
    clean.textContent = code.textContent;
    pre.replaceChildren(clean);
    found = true;
  }
  return found ? doc.body.innerHTML : null;
}
