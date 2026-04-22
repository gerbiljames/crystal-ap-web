// ZIP reading: supports STORED (method 0) and DEFLATE (method 8). Enough for
// AP artifacts (.apcrystalpre patches and the canonical output zip).

export const isPatchName = (n) => /\.apcrystal(pre)?$/i.test(n);

// Read a single entry out of a .apcrystalpre (zip).
export async function readZipEntry(bytes, targetName) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  while (pos <= bytes.length - 30) {
    if (view.getUint32(pos, true) !== 0x04034b50) { pos++; continue; }
    const method    = view.getUint16(pos + 8, true);
    const compSize  = view.getUint32(pos + 18, true);
    const nameLen   = view.getUint16(pos + 26, true);
    const extraLen  = view.getUint16(pos + 28, true);
    const name      = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    if (name === targetName) {
      const data = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) {
        const stream = new Response(data).body.pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error("unsupported compression method " + method);
    }
    pos = dataStart + compSize;
  }
  throw new Error(`${targetName} not found in patch`);
}

export async function readPatchManifest(patchBytes) {
  const raw = await readZipEntry(patchBytes, "archipelago.json");
  return JSON.parse(new TextDecoder().decode(raw));
}

// Extract every file in a zip. Used when the user drops the full AP output
// zip (patch + multidata + spoiler), so we can host the multidata on
// archipelago.gg even when we didn't generate it ourselves.
export async function extractAllZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = {};
  let pos = 0;
  while (pos <= bytes.length - 30) {
    if (view.getUint32(pos, true) !== 0x04034b50) { pos++; continue; }
    const method    = view.getUint16(pos + 8, true);
    const compSize  = view.getUint32(pos + 18, true);
    const nameLen   = view.getUint16(pos + 26, true);
    const extraLen  = view.getUint16(pos + 28, true);
    const name      = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    const chunk     = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) out[name] = chunk;
    else if (method === 8) {
      const stream = new Response(chunk).body.pipeThrough(new DecompressionStream("deflate-raw"));
      out[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    pos = dataStart + compSize;
  }
  return out;
}
