import { deflateSync, inflateSync } from "node:zlib";

import { pngSize } from "../mermaid/render.js";

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Encodes an 8-bit RGBA image as a non-interlaced PNG. */
export function encodeRgbaPng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("PNG dimensions must be positive integers");
  }
  if (data.length !== width * height * 4) {
    throw new Error("RGBA buffer does not match the image dimensions");
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", header),
    makeChunk("IDAT", deflateSync(raw, { level: 9 })),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toUpperLeft = Math.abs(estimate - upperLeft);
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
  return toAbove <= toUpperLeft ? above : upperLeft;
}

/** Decodes an 8-bit, non-interlaced RGB/RGBA PNG into RGBA pixels. */
export function decodePng(buffer: Buffer): RgbaImage {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }

  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let offset = 8;
  let sawEnd = false;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("truncated PNG chunk");
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      if (length !== 13) throw new Error("invalid PNG header");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9] ?? -1;
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error("only 8-bit PNG is supported");
      if (colorType !== 2 && colorType !== 6) throw new Error("only RGB/RGBA PNG is supported");
      if (interlace !== 0) throw new Error("interlaced PNG is not supported");
      if (data[10] !== 0 || data[11] !== 0) throw new Error("unsupported PNG compression");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height) throw new Error("PNG header is missing");
  if (!sawEnd || idat.length === 0) throw new Error("PNG image data is missing");

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is truncated");

  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride);

    switch (filter) {
      case 0:
        break;
      case 1:
        for (let index = channels; index < stride; index += 1) {
          current[index] = (current[index]! + current[index - channels]!) & 0xff;
        }
        break;
      case 2:
        for (let index = 0; index < stride; index += 1) {
          current[index] = (current[index]! + previous[index]!) & 0xff;
        }
        break;
      case 3:
        for (let index = 0; index < stride; index += 1) {
          const left = index >= channels ? current[index - channels]! : 0;
          current[index] = (current[index]! + ((left + previous[index]!) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let index = 0; index < stride; index += 1) {
          const left = index >= channels ? current[index - channels]! : 0;
          const upperLeft = index >= channels ? previous[index - channels]! : 0;
          current[index] = (current[index]! + paeth(left, previous[index]!, upperLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`unsupported PNG filter ${filter}`);
    }
    previous = current;
  }

  if (channels === 4) return { width, height, data: pixels };

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = pixels[index * 3]!;
    rgba[index * 4 + 1] = pixels[index * 3 + 1]!;
    rgba[index * 4 + 2] = pixels[index * 3 + 2]!;
    rgba[index * 4 + 3] = 0xff;
  }
  return { width, height, data: rgba };
}

/** Box-filter downscale; at most 4 samples per axis keep worst-case work bounded. */
export function resizeRgba(image: RgbaImage, width: number, height: number): RgbaImage {
  const { width: sourceWidth, height: sourceHeight, data } = image;
  const output = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const startY = Math.floor((y * sourceHeight) / height);
    const endY = Math.max(startY + 1, Math.ceil(((y + 1) * sourceHeight) / height));
    const stepY = Math.max(1, Math.floor((endY - startY) / 4));

    for (let x = 0; x < width; x += 1) {
      const startX = Math.floor((x * sourceWidth) / width);
      const endX = Math.max(startX + 1, Math.ceil(((x + 1) * sourceWidth) / width));
      const stepX = Math.max(1, Math.floor((endX - startX) / 4));

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let samples = 0;

      for (let sourceY = startY; sourceY < endY; sourceY += stepY) {
        const rowStart = sourceY * sourceWidth * 4;
        for (let sourceX = startX; sourceX < endX; sourceX += stepX) {
          const index = rowStart + sourceX * 4;
          red += data[index]!;
          green += data[index + 1]!;
          blue += data[index + 2]!;
          alpha += data[index + 3]!;
          samples += 1;
        }
      }

      const target = (y * width + x) * 4;
      output[target] = Math.round(red / samples);
      output[target + 1] = Math.round(green / samples);
      output[target + 2] = Math.round(blue / samples);
      output[target + 3] = Math.round(alpha / samples);
    }
  }

  return { width, height, data: output };
}

/**
 * Caps the longest PNG side at `maxSide`. Returns the original buffer when it already fits,
 * so an unmodified render is served byte-for-byte.
 */
export function fitPng(buffer: Buffer, maxSide: number): Buffer {
  if (maxSide < 1) throw new Error("maxSide must be positive");
  const size = pngSize(buffer);
  if (!size) throw new Error("render did not produce a valid PNG");
  if (Math.max(size.width, size.height) <= maxSide) return buffer;

  const image = decodePng(buffer);
  const scale = maxSide / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return encodeRgbaPng(resizeRgba(image, width, height));
}
