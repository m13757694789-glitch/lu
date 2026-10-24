type Formula = { token:string; source:string; display:boolean; raw:string };
type Node = Record<string, unknown>;
const escaped = (text:string, at:number) => {let n=0;while(at>0&&text[--at]==='\\')n++;return n%2===1;};

// Hide formula sources from the Markdown parser so LaTeX backslashes, underscores,
// and line breaks reach the editor unchanged. Code examples remain literal.
export function extractMath(markdown:string) {
  if(!/[$\\]/.test(markdown))return {text:markdown,formulas:[] as Formula[]};
  const formulas:Formula[]=[],prefix='CNMATH'+crypto.randomUUID().replaceAll('-','')+'X';
  let text='',i=0;
  while(i<markdown.length){
    const lineStart=i===0||markdown[i-1]==='\n';
    const fence=lineStart?/^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(markdown.slice(i)):null;
    if(fence){
      const closing=new RegExp('^ {0,3}'+fence[1][0]+'{'+fence[1].length+',}[ \\t]*$','m');
      const tail=markdown.slice(i+fence[0].length),match=closing.exec(tail);
      const end=match?i+fence[0].length+match.index+match[0].length:markdown.length;
      text+=markdown.slice(i,end);i=end;continue;
    }
    if(markdown[i]==='`'&&!escaped(markdown,i)){
      const ticks=/^`+/.exec(markdown.slice(i))![0],end=markdown.indexOf(ticks,i+ticks.length);
      if(end>=0){text+=markdown.slice(i,end+ticks.length);i=end+ticks.length;continue;}
    }
    let open='',close='',display=false;
    if(!escaped(markdown,i)){
      if(markdown.startsWith('$$',i)){open=close='$$';display=true;}
      else if(markdown.startsWith('\\[',i)){open='\\[';close='\\]';display=true;}
      else if(markdown.startsWith('\\(',i)){open='\\(';close='\\)';}
      else if(markdown[i]==='$'&&markdown[i+1]!=='$'&&!/\s/.test(markdown[i+1]||' ')){open=close='$';}
    }
    if(open){
      let end=markdown.indexOf(close,i+open.length);
      while(end>=0&&escaped(markdown,end))end=markdown.indexOf(close,end+close.length);
      const source=end<0?'':markdown.slice(i+open.length,end);
      const valid=end>=0&&source.trim()&&source.length<=32000&&(display||!source.includes('\n'))&&
        (open!=='$'||(!/\s/.test(source.at(-1)!)&&!/\d/.test(markdown[end+1]||'')&&!source.includes('$')));
      if(valid){
        const formula={token:prefix+formulas.length+'END',source:source.trim(),display,raw:markdown.slice(i,end+close.length)};formulas.push(formula);
        text+=display?'\n\n'+formula.token+'\n\n':formula.token;i=end+close.length;continue;
      }
    }
    text+=markdown[i++];
  }
  return {text,formulas};
}

function restoreContent(value:unknown,formulas:Formula[]):unknown {
  if(typeof value==='string')return formulas.reduce((text,f)=>text.replaceAll(f.token,f.raw),value);
  if(Array.isArray(value))return value.flatMap(item=>{
    const node=item as Node;
    if(node?.type!=='text'||typeof node.text!=='string')return [restoreContent(item,formulas)];
    let pieces:unknown[]=[node];
    for(const formula of formulas)pieces=pieces.flatMap(piece=>{
      const part=piece as Node;if(part.type!=='text'||typeof part.text!=='string')return [part];
      const texts=part.text.split(formula.token),out:unknown[]=[];
      texts.forEach((text,index)=>{if(index)out.push({type:'math',content:formula.source});if(text)out.push({...part,text});});
      return out;
    });
    return pieces;
  });
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restoreContent(item,formulas)]));
  return value;
}

function restoreBlocks(blocks:unknown[],formulas:Formula[]):unknown[] {
  return blocks.map(value=>{
    const block=value as Node;
    const children=Array.isArray(block.children)?restoreBlocks(block.children,formulas):block.children;
    const plain=Array.isArray(block.content)?block.content.map(item=>(item as Node).text||'').join(''):block.content;
    const display=formulas.find(f=>f.display&&typeof plain==='string'&&plain.trim()===f.token);
    if(display){
      if(block.type==='paragraph')return {...block,type:'mathBlock',props:{},content:display.source,children};
      return {...block,content:[],children:[{type:'mathBlock',content:display.source},...(Array.isArray(children)?children:[])]};
    }
    return {...block,content:restoreContent(block.content,formulas),children};
  });
}

export function parseMathMarkdown(markdown:string,parse:(text:string)=>unknown[]) {
  const safe=markdown.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,'[$1（外部图片，需另行上传）]($2)');
  const {text,formulas}=extractMath(safe);
  return restoreBlocks(parse(text),formulas);
}

// Upgrade old formula blocks only in the editor's copy. IDs and attachment URLs
// remain intact, and opening a note does not write a migration to the database.
export function normalizeMathBlocks(blocks:unknown[]):unknown[] {
  return blocks.map(value=>{
    const block=value as Node;
    const children=Array.isArray(block.children)?normalizeMathBlocks(block.children):block.children;
    if(block.type==='math'&&block.props&&typeof (block.props as Node).formula==='string')
      return {...block,type:'mathBlock',props:{},content:(block.props as Node).formula,children};
    if(block.type==='codeBlock'||block.type==='mathBlock')return {...block,children};
    if(Array.isArray(block.content)){
      const formulas:Formula[]=[],content=block.content.map(value=>{
        const item=value as Node;
        if(item.type!=='text'||typeof item.text!=='string'||(item.styles as Node)?.code)return item;
        const extracted=extractMath(item.text);formulas.push(...extracted.formulas);return {...item,text:extracted.text};
      });
      return restoreBlocks([{...block,content,children}],formulas)[0];
    }
    return {...block,children};
  });
}
