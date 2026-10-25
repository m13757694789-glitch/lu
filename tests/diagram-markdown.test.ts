import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramKind, hasDiagramFence, validateMermaidSource } from '../src/lib/diagram-markdown.ts';
import { parseMathMarkdown } from '../src/lib/math-markdown.ts';
import { contentSchema } from '../src/lib/validation.ts';

test('diagram language markers work without treating ordinary code examples as diagrams', () => {
  assert.equal(diagramKind(' Mermaid '),'mermaid');assert.equal(diagramKind('SVG'),'svg');
  for (const language of ['css','arduino','xml','markdown','javascript']) assert.equal(diagramKind(language),null);
  for (const source of ['```mermaid\nflowchart TD\n A-->B\n```','标题\n\n~~~~svg\n<svg/>\n~~~~','   ```svg\r\n<svg/>']) assert(hasDiagramFence(source));
  for (const source of ['普通文字 mermaid','```css\nflowchart TD','`svg`','```svg-example']) assert(!hasDiagramFence(source));
});

test('diagram fences retain exact SVG, backslashes, dollars and Markdown-like image source', () => {
  const source = ['```svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120">','<text>$F=ma$ \\alpha ![image](https://example.com/image.png)</text>','</svg>','```','','```mermaid','flowchart TD',' A["$F=ma$"] --> B["\\[source\\]"]','```'].join('\n');
  let parsed='';parseMathMarkdown(source,text=>{parsed=text;return [];});
  assert.equal(parsed,source);
});

test('ordinary Markdown image URLs reach the existing image parser intact', () => {
  const source='![课堂插图](https://example.com/image.png)';
  const blocks=[{id:'image',type:'image',props:{url:'https://example.com/image.png'},children:[]}];
  let parsed='';const result=parseMathMarkdown(source,text=>{parsed=text;return blocks;});
  assert.equal(parsed,source);assert.equal((result[0] as any).props.url,blocks[0].props.url);
});

test('diagram source uses the existing codeBlock persistence format and is not transformed', () => {
  const source='<svg xmlns="http://www.w3.org/2000/svg"><text>连杆 $x$</text><script>alert(1)</script></svg>';
  const blocks=[{id:'diagram',type:'codeBlock',props:{language:'svg'},content:[{type:'text',text:source,styles:{}}],children:[]}];
  const parsed=contentSchema.parse(JSON.parse(JSON.stringify(blocks)));
  assert.deepEqual(parsed,blocks);
});

test('Mermaid rejects external-resource styles and configuration before creating DOM', () => {
  for (const source of ['%%{init:{"securityLevel":"loose"}}%%\nflowchart TD\nA-->B','---\nconfig:\n theme: dark\n---\nflowchart TD\nA-->B','flowchart TD\nA@{img:"https://example.com/pixel"}','flowchart TD\nA["<img src=x>"]','flowchart TD\nA-->B\nclassDef x fill:url(https://example.com/pixel);',String.raw`flowchart TD
A-->B
classDef x fill:u\72l(https://example.com/pixel);`,'a'.repeat(50_001)]) assert.throws(()=>validateMermaidSource(source));
  assert.doesNotThrow(()=>validateMermaidSource('flowchart TD\nA[识别构件] --> B[检查结果]\nclassDef highlight fill:#ccc,stroke:#777;'));
});
