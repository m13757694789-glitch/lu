import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMath,normalizeMathBlocks,parseMathMarkdown } from '../src/lib/math-markdown.ts';
import { contentSchema } from '../src/lib/validation.ts';

const paragraph=(text:string)=>({id:'paragraph',type:'paragraph',content:[{type:'text',text,styles:{bold:true}}],children:[]});

test('four LaTeX delimiters preserve commands, subscripts and multiline environments',()=>{
  const result=extractMath(String.raw`行内 $x_i^2$ 和 \(\frac{a}{b}\)\n\n$$\begin{aligned}a&=b\\c&=d\end{aligned}$$\n\n\[\int_0^1 x\,dx\]`);
  assert.deepEqual(result.formulas.map(f=>({source:f.source,display:f.display})),[
    {source:'x_i^2',display:false},{source:String.raw`\frac{a}{b}`,display:false},
    {source:String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`,display:true},{source:String.raw`\int_0^1 x\,dx`,display:true},
  ]);
});

test('code examples, escaped delimiters, prices and unmatched input stay literal',()=>{
  const text='`$x$`\n```latex\n$$x$$\n\\(y\\)\n```\n~~~\n$x$\n~~~\n\\$5 and $10\n$missing\n\\(unfinished';
  assert.equal(extractMath(text).formulas.length,0);
  assert.equal(extractMath(text).text,text);
});

test('Markdown conversion restores inline source and formatting and produces standalone blocks',()=>{
  const mixed=parseMathMarkdown('速度 $v=\\frac{s}{t}$。',text=>[paragraph(text)]) as any[];
  assert.deepEqual(mixed[0].content,[{type:'text',text:'速度 ',styles:{bold:true}},{type:'math',content:String.raw`v=\frac{s}{t}`},{type:'text',text:'。',styles:{bold:true}}]);
  const display=parseMathMarkdown('$$x_i^2$$',text=>[paragraph(text.trim())]) as any[];
  assert.equal(display[0].type,'mathBlock');assert.equal(display[0].content,'x_i^2');assert.equal(display[0].id,'paragraph');
});

test('opening legacy math preserves IDs, nesting, images and original data',()=>{
  const old=[{id:'old',type:'math',props:{formula:String.raw`\sum_{i=1}^n i`},children:[]},
    {id:'list',type:'bulletListItem',content:[{type:'text',text:'$x$ 和代码 $y$',styles:{code:true}}],children:[paragraph('现有正文 \\(a+b\\)')]},
    {id:'image',type:'image',props:{url:'/api/files/example'},children:[]}];
  const before=JSON.stringify(old),upgraded=normalizeMathBlocks(old) as any[];
  assert.equal(JSON.stringify(old),before);assert.equal(upgraded[0].id,'old');assert.equal(upgraded[0].type,'mathBlock');assert.equal(upgraded[0].content,String.raw`\sum_{i=1}^n i`);
  assert.equal(upgraded[1].children[0].content[1].type,'math');assert.equal(upgraded[1].content[0].text,'$x$ 和代码 $y$');assert.deepEqual(upgraded[2],old[2]);
  assert(contentSchema.safeParse(upgraded).success);
});

test('new math and legacy math both pass persistence validation and invalid block types still fail',()=>{
  assert(contentSchema.safeParse([{id:'a',type:'mathBlock',content:'x+y'},{id:'b',type:'paragraph',content:[{type:'math',content:'z'}]},{id:'c',type:'math',props:{formula:'legacy'}}]).success);
  assert.equal(contentSchema.safeParse([{id:'a',type:'unsupportedLatexBlock',content:'x'}]).success,false);
});
