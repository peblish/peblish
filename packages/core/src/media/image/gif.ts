import { expectThat, invalid, type Cleaned } from './types.ts';

// GIF: the screen, the colour tables, the frames (and their timing) are copied; comments,
// plain-text blocks and every application extension except the loop count (NETSCAPE2.0,
// ANIMEXTS1.0), which is where XMP lives, are dropped. What is kept has exactly the shape the
// format defines: a graphic control block is one 4-byte sub-block, a loop count one 3-byte
// sub-block, and every frame lies inside the screen with a legal code size. A block with extra
// sub-blocks is refused, since that is where a marker would hide. Only the LZW data of a frame
// stays opaque (it cannot be judged without decoding the pixels).

const LOOP_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);
const EXTENSION = 0x21;
const GRAPHIC_CONTROL = 0xf9;
const APPLICATION = 0xff;
const FRAME = 0x2c;
const TRAILER = 0x3b;

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
    if (block === TRAILER) break;
    if (block === EXTENSION) {
      const label = input[pos + 1] ?? 0;
      const end = skipSubBlocks(input, pos + 2);
      if (label === GRAPHIC_CONTROL) {
        // 0x21 0xF9, a 4-byte sub-block (disposal, delay, transparent index), the terminator.
        expectThat(input[pos + 2] === 4 && end === pos + 8, 'GIF: bad graphic control block');
        kept.push(input.subarray(pos, end));
      } else if (label === APPLICATION && input[pos + 2] === 11 && LOOP_APPLICATIONS.has(input.toString('latin1', pos + 3, pos + 14))) {
        // 0x21 0xFF 11 <name>, one 3-byte sub-block (1, loop count), the terminator.
        expectThat(end === pos + 19 && input[pos + 14] === 3 && input[pos + 15] === 1, 'GIF: bad loop count block');
        kept.push(input.subarray(pos, end));
      }
      pos = end;
    } else if (block === FRAME) {
      expectThat(pos + 10 <= input.length, 'GIF: frame header cut short');
      // The frame is a rectangle inside the logical screen; decoders do not agree on one that is not.
      const [left, top, frameWidth, frameHeight] = [
        input.readUInt16LE(pos + 1),
        input.readUInt16LE(pos + 3),
        input.readUInt16LE(pos + 5),
        input.readUInt16LE(pos + 7),
      ];
      expectThat(frameWidth > 0 && frameHeight > 0, 'GIF: empty frame');
      expectThat(left + frameWidth <= width && top + frameHeight <= height, 'GIF: a frame outside the screen');
      const local = colourTable(input[pos + 9] ?? 0);
      // Then the LZW minimum code size, then the data sub-blocks.
      expectThat(pos + 10 + local < input.length, 'GIF: frame cut short');
      const codeSize = input[pos + 10 + local] ?? 0;
      expectThat(codeSize >= 1 && codeSize <= 8, 'GIF: bad LZW code size');
      const end = skipSubBlocks(input, pos + 10 + local + 1);
      kept.push(input.subarray(pos, end));
      frames++;
      pos = end;
    } else {
      throw invalid(`GIF: unknown block 0x${(block ?? 0).toString(16)}`);
    }
  }
  expectThat(frames > 0, 'GIF: no frames');
  return { bytes: Buffer.concat([...kept, Buffer.from([TRAILER])]), width, height };
}
