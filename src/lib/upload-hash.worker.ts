import { hashUploadFile } from "./upload-hash";

self.onmessage = async (event: MessageEvent<{ file: File; partSize: number }>) => {
  try {
    const hashes=await hashUploadFile(event.data.file,event.data.partSize,false,(index,sha256)=>self.postMessage({index,sha256}));
    self.postMessage({sha256:hashes.sha256});
  }
  catch { self.postMessage({ error: "无法读取原文件，请重新选择文件" }); }
};
