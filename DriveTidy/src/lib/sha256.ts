// Incremental SHA-256 so whole files can be hashed chunk by chunk.
// crypto.subtle.digest() has no streaming input, so it would need the entire
// file in memory; this keeps memory bounded to one chunk.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private bytes = 0;

  update(data: Uint8Array): this {
    this.bytes += data.length;
    let i = 0;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = data.length - i;
    }
    return this;
  }

  digestHex(): string {
    const bits = this.bytes * 8;
    const pad = new Uint8Array((this.bufLen < 56 ? 56 : 120) - this.bufLen + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, "0")).join("");
  }

  private block(d: Uint8Array, o: number) {
    const w = this.w;
    const at = (i: number) => d[i] ?? 0;
    const W = (i: number) => w[i] ?? 0;
    for (let t = 0; t < 16; t++)
      w[t] =
        (at(o + t * 4) << 24) |
        (at(o + t * 4 + 1) << 16) |
        (at(o + t * 4 + 2) << 8) |
        at(o + t * 4 + 3);
    for (let t = 16; t < 64; t++) {
      const a = W(t - 15),
        b = W(t - 2);
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (W(t - 16) + s0 + W(t - 7) + s1) | 0;
    }
    const H = this.h;
    let a = H[0]!,
      b = H[1]!,
      c = H[2]!,
      dd = H[3]!,
      e = H[4]!,
      f = H[5]!,
      g = H[6]!,
      hh = H[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[t]! + W(t)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (dd + t1) | 0;
      dd = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const h = this.h;
    h[0]! += a;
    h[1]! += b;
    h[2]! += c;
    h[3]! += dd;
    h[4]! += e;
    h[5]! += f;
    h[6]! += g;
    h[7]! += hh;
  }
}

export const CHUNK = 4 * 1024 * 1024;

/** Read a slice of a Blob (works with browsers and test environments lacking Blob.arrayBuffer). */
export async function readBytes(
  blob: Blob,
  start: number,
  end: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const part = blob.slice(start, end);
  if (typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsArrayBuffer(part);
  });
}

/** Full-content SHA-256 of a Blob, read in bounded chunks. Yields between chunks so the UI stays responsive. */
export async function hashBlobFull(
  blob: Blob,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
): Promise<string> {
  const h = new Sha256();
  for (let o = 0; o < blob.size; o += CHUNK) {
    signal?.throwIfAborted();
    const bytes = await readBytes(blob, o, Math.min(blob.size, o + CHUNK));
    if (bytes.length !== Math.min(CHUNK, blob.size - o))
      throw new Error("File changed or could not be fully read");
    h.update(bytes);
    onBytes?.(bytes.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return h.digestHex();
}

/** Exact byte-for-byte comparison of two Blobs, chunk by chunk. */
export async function blobsIdentical(a: Blob, b: Blob, signal?: AbortSignal): Promise<boolean> {
  if (a.size !== b.size) return false;
  for (let o = 0; o < a.size; o += CHUNK) {
    signal?.throwIfAborted();
    const end = Math.min(a.size, o + CHUNK);
    const [x, y] = await Promise.all([readBytes(a, o, end), readBytes(b, o, end)]);
    if (x.length !== end - o || y.length !== end - o) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
