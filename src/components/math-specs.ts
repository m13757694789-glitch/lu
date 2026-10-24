import { createReactInlineMathSpec,createReactMathBlockSpec } from '@blocknote/math-block';
import { plainContentToString } from '@blocknote/core';
import katex from 'katex';

function externalMath(source:string,inline:boolean) {
  const wrapper=document.createElement('div');
  wrapper.innerHTML=katex.renderToString(source,{output:'mathml',displayMode:!inline,throwOnError:false,trust:false});
  let math=wrapper.querySelector('math');
  if(!math){
    // Invalid input must also survive copying and Markdown export.
    math=document.createElementNS('http://www.w3.org/1998/Math/MathML','math');
    const semantics=document.createElementNS(math.namespaceURI,'semantics');
    const label=document.createElementNS(math.namespaceURI,'mtext');label.textContent='无效的公式';
    const annotation=document.createElementNS(math.namespaceURI,'annotation');annotation.setAttribute('encoding','application/x-tex');annotation.textContent=source;
    semantics.append(label,annotation);math.append(semantics);
  }
  math.setAttribute('display',inline?'inline':'block');
  return {dom:math as unknown as HTMLElement};
}

export const inlineMathSpec=createReactInlineMathSpec();
// The interactive React preview contains popup <div>s. Putting that preview in
// clipboard HTML inside a paragraph makes the browser split it and lose trailing
// text. Serialize only the editable source; the node view renders its own preview.
inlineMathSpec.implementation.render=inline=>{
  const dom=document.createElement('span'),contentDOM=document.createElement('span');
  dom.setAttribute('data-inline-content-type','math');contentDOM.setAttribute('data-editable','');dom.append(contentDOM);
  return {dom,contentDOM};
};
inlineMathSpec.implementation.toExternalHTML=inline=>externalMath(inline.content,true);

export const mathBlockSpec=createReactMathBlockSpec();
mathBlockSpec.implementation.toExternalHTML=block=>externalMath(plainContentToString(block.content),false);
