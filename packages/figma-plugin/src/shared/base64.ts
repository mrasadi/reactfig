/**
 * Chunked to avoid call-stack limits on String.fromCharCode(...bigArray)
 * for large assets. Works in both the browser (UI iframe, has btoa/atob)
 * and the Figma sandbox (does NOT have btoa/atob — verified absent from
 * plugin-typings' global scope, hence the manual implementation here
 * rather than relying on it).
 */
const CHUNK_SIZE = 0x8000;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  const globalBtoa = (globalThis as Record<string, unknown>).btoa as ((s: string) => string) | undefined;
  if (typeof globalBtoa === "function") return globalBtoa(binary);
  return manualBtoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const globalAtob = (globalThis as Record<string, unknown>).atob as ((s: string) => string) | undefined;
  const binary = typeof globalAtob === "function" ? globalAtob(base64) : manualAtob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function manualBtoa(binary: string): string {
  let result = "";
  for (let i = 0; i < binary.length; i += 3) {
    const b0 = binary.charCodeAt(i);
    const b1 = binary.charCodeAt(i + 1);
    const b2 = binary.charCodeAt(i + 2);
    const hasB1 = i + 1 < binary.length;
    const hasB2 = i + 2 < binary.length;
    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (hasB1 ? b1 >> 4 : 0)];
    result += hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (hasB2 ? b2 >> 6 : 0)] : "=";
    result += hasB2 ? BASE64_CHARS[b2 & 0x3f] : "=";
  }
  return result;
}

function manualAtob(base64: string): string {
  const clean = base64.replace(/=+$/, "");
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return result;
}
