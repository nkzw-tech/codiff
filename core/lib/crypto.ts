const bytesToHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const sha256 = async (value: string) =>
  bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
