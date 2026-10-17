import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type UploadHashes = { parts: string[]; sha256: string };

// Streaming bounds memory even for multi-hour recordings. Workers keep hashing off the editor's thread.
export async function hashUploadFile(file: Blob, partSize: number, yieldToUI = false): Promise<UploadHashes> {
  const full = sha256.create(); const parts: string[] = [];
  let sinceYield = 0;
  for (let offset = 0; offset < file.size; offset += partSize) {
    const hash = sha256.create(); const reader = file.slice(offset, offset + partSize).stream().getReader();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        hash.update(chunk.value); full.update(chunk.value); sinceYield += chunk.value.length;
        if (yieldToUI && sinceYield >= 512 * 1024) { sinceYield = 0; await new Promise(resolve => setTimeout(resolve, 0)); }
      }
    } finally { await reader.cancel().catch(() => {}); }
    parts.push(bytesToHex(hash.digest()));
  }
  return { parts, sha256: bytesToHex(full.digest()) };
}
