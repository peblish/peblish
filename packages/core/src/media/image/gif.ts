import { expectThat, invalid, type Cleaned } from './types.ts';

// GIF: the screen, the colour tables, the frames (and their timing) are copied; comments,
// plain-text blocks and every application extension except the loop count (NETSCAPE2.0,
// ANIMEXTS1.0), which is where XMP lives, are dropped.

const LOOP_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/** The end of the sub-blocks that start at `pos` (the position after their zero terminator). */
function skipSubBlocks(input: Buffer, pos: number): number {
  for (;;) {
    expectThat(pos < input.length, 'GIF: block cut short');
    const length = input[pos] ?? 0;
    pos += 1 + length;
    if (length === 0) return pos;
  }
}

export function cleanGif(input: Buffer): Cleaned {
  const header = input.toString('latin1', 0, 6);
  expectThat(header === 'GIF87a' || header === 'GIF89a', 'not a GIF');
  expectThat(input.length >= 13, 'GIF: screen descriptor cut short');
  const width = input.readUInt16LE(6);
  const height = input.readUInt16LE(8);
  expectThat(width > 0 && height > 0, 'GIF: empty screen');
  const colourTable = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let pos = 13 + colourTable(input[10] ?? 0);
  expectThat(pos <= input.length, 'GIF: colour table cut short');
  const kept: Buffer[] = [input.subarray(0, pos)];
  let frames = 0;
  for (;;) {
    expectThat(pos < input.length, 'GIF: no trailer');
    const block = input[pos];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = input[pos + 1] ?? 0;
      const end = skipSubBlocks(input, pos + 2);
      const application = label === 0xff && LOOP_APPLICATIONS.has(input.toString('latin1', pos + 3, pos + 14));
      if (label === 0xf9 || application) kept.push(input.subarray(pos, end));
      pos = end;
    } else if (block === 0x2c) {
      expectThat(pos + 10 <= input.length, 'GIF: frame header cut short');
      const local = colourTable(input[pos + 9] ?? 0);
      // Then the LZW minimum code size, then the data sub-blocks.
      const end = skipSubBlocks(input, pos + 10 + local + 1);
      kept.push(input.subarray(pos, end));
      frames++;
      pos = end;
    } else {
      throw invalid(`GIF: unknown block 0x${(block ?? 0).toString(16)}`);
    }
  }
  expectThat(frames > 0, 'GIF: no frames');
  return { bytes: Buffer.concat([...kept, Buffer.from([0x3b])]), width, height };
}
