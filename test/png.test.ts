import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import {
  decodePng,
  encodeRgbaPng,
  fitPng,
  resizeRgba,
  type RgbaImage,
} from "../src/http/png.js";
import { pngSize } from "../src/mermaid/render.js";

const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

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
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toUpperLeft = Math.abs(estimate - upperLeft);
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
  return toAbove <= toUpperLeft ? above : upperLeft;
}

/** Builds a PNG whose scanlines use the requested filter, like a browser encoder would. */
function pngWithFilter(image: RgbaImage, filter: number): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous: Buffer = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    const target = y * (stride + 1);
    raw[target] = filter;
    for (let index = 0; index < stride; index += 1) {
      const value = data[rowStart + index]!;
      const left = index >= 4 ? data[rowStart + index - 4]! : 0;
      const above = previous[index]!;
      const upperLeft = index >= 4 ? previous[index - 4]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = (left + above) >> 1;
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      raw[target + 1 + index] = (value - predictor) & 0xff;
    }
    previous = data.subarray(rowStart, rowStart + stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SAMPLE: RgbaImage = {
  width: 2,
  height: 2,
  data: Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]),
};

test("decodePng handles every PNG filter type", () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    const decoded = decodePng(pngWithFilter(SAMPLE, filter));
    assert.equal(decoded.width, 2, `filter ${filter}`);
    assert.equal(decoded.height, 2, `filter ${filter}`);
    assert.deepEqual(decoded.data, SAMPLE.data, `filter ${filter}`);
  }
});

test("encodeRgbaPng round-trips through decodePng", () => {
  const decoded = decodePng(encodeRgbaPng(SAMPLE));
  assert.deepEqual(decoded, SAMPLE);
  assert.deepEqual(pngSize(encodeRgbaPng(SAMPLE)), { width: 2, height: 2 });
});

test("fitPng leaves a PNG that already fits byte-for-byte", () => {
  const encoded = encodeRgbaPng(SAMPLE);
  assert.equal(fitPng(encoded, 2400), encoded);
  assert.equal(fitPng(encoded, 2), encoded);
});

test("fitPng caps the long side and keeps the aspect ratio", () => {
  const image: RgbaImage = {
    width: 10,
    height: 6,
    data: Buffer.alloc(10 * 6 * 4, 200),
  };
  const scaled = fitPng(encodeRgbaPng(image), 5);
  assert.deepEqual(pngSize(scaled), { width: 5, height: 3 });
});

test("resizeRgba averages pixels instead of picking one", () => {
  const resized = resizeRgba(SAMPLE, 1, 1);
  assert.deepEqual(resized.data, Buffer.from([128, 128, 128, 255]));
  assert.deepEqual(pngSize(encodeRgbaPng(resized)), { width: 1, height: 1 });
});

test("decodePng rejects non-PNG input", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  assert.throws(() => fitPng(Buffer.alloc(24), 2400), /valid PNG/);
});
