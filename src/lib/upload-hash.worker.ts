import { hashUploadFile } from "./upload-hash";

self.onmessage = async (event: MessageEvent<{ file: File; partSize: number }>) => {
  try { self.postMessage({ hashes: await hashUploadFile(event.data.file, event.data.partSize) }); }
  catch { self.postMessage({ error: "无法读取原文件，请重新选择文件" }); }
};
