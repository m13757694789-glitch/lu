import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedAll } from '../src/lib/cloud-store.ts';

test('cloud lists retain attachments beyond the provider default page limit',async()=>{
  const attachments=Array.from({length:1003},(_,id)=>({id,size:id+1}));
  const result=await checkedAll<{id:number;size:number}>(async(start,end)=>({data:attachments.slice(start,end+1),error:null}));
  assert.equal(result.length,1003);
  assert.equal(result.at(-1)?.id,1002);
  assert.equal(result.reduce((sum,row)=>sum+row.size,0),503506);
});

test('a later cloud page failure rejects the partial result',async()=>{
  await assert.rejects(checkedAll(async(start)=>start===0
    ?{data:Array.from({length:1000},(_,id)=>({id})),error:null}
    :{data:null,error:{code:'08006',message:'connection lost'}}),/云端存储暂时无法响应/);
});
