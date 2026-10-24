import { createExtension } from '@blocknote/core';
import { InputRule,inputRules } from '@handlewithcare/prosemirror-inputrules';

// Inline-spec extensions are not automatically registered by core 0.55. Register
// guarded rules explicitly, and leave escaped dollars, code, and $$ openers alone.
export const mathInputRules=createExtension({
  key:'classnote-math-input',
  inputRules:[
    {find:/^\$\$([^\n]+)\$\$$/,replace:({match})=>({type:'mathBlock',content:match[1].trim()})},
    {find:/^\\\[([^\n]+)\\\]$/,replace:({match})=>({type:'mathBlock',content:match[1].trim()})},
  ],
  prosemirrorPlugins:[inputRules({rules:[/(?<![\\$])\$([^\s$](?:[^$\n]*[^\s$])?)\$$/,/(?<!\\)\\\(([^\n]+?)\\\)$/].map(find=>new InputRule(find,(state,match,start,end)=>{
    const source=match[1]?.trim(),node=state.schema.nodes.math;
    if(!source||!node||state.selection.$from.parent.type.spec.code||state.selection.$from.marks().some(mark=>mark.type.spec.code))return null;
    return state.tr.replaceRangeWith(start,end,node.create(null,state.schema.text(source)));
  }))})],
});
