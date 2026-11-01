/** A ZIP archive of `files` (a string is stored, bytes are written as deflated), for workbook tests. */
export function zip(files: Record<string, string | Uint8Array>, sizes: Record<string, number> = {}): Uint8Array {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (out: number[], n: number) => out.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (out: number[], n: number) => out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = typeof text === "string" ? encoder.encode(text) : text;
    const method = typeof text === "string" ? 0 : 8;
    const size = sizes[name] ?? data.length;
    const offset = parts.length;
    u32(parts, 0x04034b50);
    [20, 0, method, 0, 0].forEach((n) => u16(parts, n));
    [0, data.length, size].forEach((n) => u32(parts, n));
    u16(parts, nameBytes.length);
    u16(parts, 0);
    parts.push(...nameBytes, ...data);
    u32(central, 0x02014b50);
    [20, 20, 0, method, 0, 0].forEach((n) => u16(central, n));
    [0, data.length, size].forEach((n) => u32(central, n));
    [nameBytes.length, 0, 0, 0, 0].forEach((n) => u16(central, n));
    u32(central, 0);
    u32(central, offset);
    central.push(...nameBytes);
    count += 1;
  }
  const end: number[] = [];
  u32(end, 0x06054b50);
  [0, 0, count, count].forEach((n) => u16(end, n));
  u32(end, central.length);
  u32(end, parts.length);
  u16(end, 0);
  return new Uint8Array([...parts, ...central, ...end]);
}
