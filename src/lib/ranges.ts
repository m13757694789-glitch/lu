export function byteRange(value: string | null, size: number, maximum = size) {
  let start=0, end=size-1;
  if(value) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(value);
    if(!match||(!match[1]&&!match[2])) return null;
    if(!match[1]) { const suffix=Number(match[2]); if(!Number.isSafeInteger(suffix)||suffix<1) return null; start=Math.max(0,size-suffix); }
    else { start=Number(match[1]); if(match[2]) end=Math.min(end,Number(match[2])); }
  }
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start) return null;
  return {start,end:Math.min(end,start+maximum-1)};
}
