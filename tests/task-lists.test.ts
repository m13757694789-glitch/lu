import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMarkdownTaskList, normalizeTaskListBlocks } from '../src/lib/task-lists.ts';
import { contentSchema } from '../src/lib/validation.ts';

const text = (value: string, styles = {}) => ({type:'text',text:value,styles});
const block = (id: string, type: string, content: unknown[], children: unknown[] = []) => ({id,type,props:{textColor:'default'},content,children});

test('single and nested GFM task lines are recognized without needing two bullet items', () => {
  for (const value of ['- [ ] 任务','* [x] 完成','+ [X] 完成','  - [ ] 子任务','> - [ ] 引用任务','1. [x] 完成','- [ ]']) assert(hasMarkdownTaskList(value),value);
  for (const value of ['- 普通项目','1. 普通项目','正文 [ ] 文字','`- [ ] 代码`','- [yes] 非任务']) assert(!hasMarkdownTaskList(value),value);
});

test('legacy literal tasks keep IDs, rich content, nesting and completion when normalized', () => {
  const original = [block('todo','paragraph',[text('- ['),text(' ] ',{bold:true}),text('学习任务',{italic:true}),{type:'math',content:'x_i'}, {type:'link',href:'https://example.com',content:[text('来源')]}],
    [block('done','bulletListItem',[text('[X] 已完成')])])];
  const before = JSON.stringify(original), result = normalizeTaskListBlocks(original) as typeof original;
  assert.equal(JSON.stringify(original),before);
  assert.equal(result[0].id,'todo');assert.equal(result[0].type,'checkListItem');
  assert.equal((result[0].props as any).checked,false);
  assert.deepEqual(result[0].content,original[0].content.slice(2));
  assert.equal((result[0].children[0] as any).type,'checkListItem');
  assert.equal((result[0].children[0] as any).props.checked,true);
  assert(contentSchema.safeParse(result).success);
  assert.deepEqual(normalizeTaskListBlocks(result),result);
});

test('ordinary lists, headings, formulas, tables and code examples remain unchanged', () => {
  const original = [block('p','paragraph',[text('正文 - [ ] 例子')]),block('bullet','bulletListItem',[text('普通列表')]),block('numbered','numberedListItem',[text('普通顺序')]),
    block('code','codeBlock',[text('- [x] 代码')]),block('inline','paragraph',[text('- [ ] 行内代码',{code:true})]),block('heading','heading',[text('- [ ] 标题')]),
    {id:'table',type:'table',content:{type:'tableContent',rows:[]}}, {id:'formula',type:'mathBlock',content:'x+y'},
    {...block('checked','checkListItem',[text('已完成')]),props:{checked:true}}];
  assert.deepEqual(normalizeTaskListBlocks(original),original.map(value=>({...value,children:'children' in value ? value.children : undefined})));
});

test('paragraphs need a list marker, and checkbox prefixes require a word boundary', () => {
  const original = [block('brackets','paragraph',[text('[ ] 普通方括号')]),block('joined','paragraph',[text('- [x]word')]),block('escaped','paragraph',[text('\\- [ ] 转义')])];
  assert.deepEqual(normalizeTaskListBlocks(original),original);
  const done = normalizeTaskListBlocks([block('done','paragraph',[text('+ [x] 完成')])]) as any[];
  assert.equal(done[0].props.checked,true);assert.equal(done[0].content[0].text,'完成');
});
