/**
 * TGA decode + PNG encode test for img-preview.
 * Generates several TGA variants (uncompressed 24/32-bit, RLE 32-bit, 16-bit,
 * 8-bit grayscale, color-mapped, both origins) and verifies decodeTga +
 * encodePng round-trip correctness.
 * Run: node scripts/test-tga.mjs
 */
import { decodeTga, encodePng } from "../lib/index.js";
import { writeFileSync, readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${extra ?? ""}`);
  }
}

function tgaHeader({ width, height, imageType = 2, depth = 24, cmType = 0, cmLength = 0, cmEntryBits = 0, descriptor = 0 }) {
  const h = Buffer.alloc(18);
  h[1] = cmType;
  h[2] = imageType;
  h.writeUInt16LE(cmLength, 5);
  h[7] = cmEntryBits;
  h.writeUInt16LE(width, 12);
  h.writeUInt16LE(height, 14);
  h[16] = depth;
  h[17] = descriptor;
  return h;
}

// ---- 1. uncompressed 24-bit, bottom-left origin, 4 quadrants ----
{
  console.log("1) uncompressed 24-bit (type 2, bottom-left)");
  const w = 4, h = 4;
  // file order is bottom row first: row0(bottom)=red, row3(top)=blue
  const rows = [
    [255, 0, 0], // bottom
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255] // top
  ];
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 3;
      // BGR order
      px[off] = rows[y][2];
      px[off + 1] = rows[y][1];
      px[off + 2] = rows[y][0];
    }
  }
  const tga = Buffer.concat([tgaHeader({ width: w, height: h, imageType: 2, depth: 24 }), px]);
  const { rgba, width, height } = decodeTga(tga);
  check("dimensions 4x4", width === 4 && height === 4);
  // top-left pixel should be top row = white
  check("top-left=white", rgba[0] === 255 && rgba[1] === 255 && rgba[2] === 255);
  // bottom-left pixel (after flip) = red
  const bl = (3 * w + 0) * 4;
  check("bottom-left=red", rgba[bl] === 255 && rgba[bl + 1] === 0 && rgba[bl + 2] === 0);
  check("alpha=255", rgba[3] === 255);
  writeFileSync(new URL("./test-24bit.tga", import.meta.url), tga);
}

// ---- 2. RLE 32-bit (type 10), top-down origin ----
{
  console.log("2) RLE 32-bit (type 10, top-down)");
  const w = 4, h = 4;
  const header = tgaHeader({ width: w, height: h, imageType: 10, depth: 32, descriptor: 0x20 });
  // pixel stream: 8 red pixels (RLE packet: 0x87 = repeat flag + 7, then one pixel), then 8 blue (0x87 + blue)
  const rle = Buffer.from([
    0x80 | 7, 0, 0, 255, 255, // repeat 8x BGRA red (B=0,G=0,R=255,A=255)
    0x80 | 7, 255, 0, 0, 128 // repeat 8x BGRA blue with alpha 128
  ]);
  const tga = Buffer.concat([header, rle]);
  const { rgba, width, height } = decodeTga(tga);
  check("dimensions 4x4", width === 4 && height === 4);
  check("pixel0=red", rgba[0] === 255 && rgba[1] === 0 && rgba[2] === 0 && rgba[3] === 255);
  // pixel 8 = first blue pixel (RLE packet 2)
  check("pixel8=blue-a128", rgba[8 * 4] === 0 && rgba[8 * 4 + 2] === 255 && rgba[8 * 4 + 3] === 128);
  // pixel 15 = last blue pixel (RLE run end)
  check("pixel15=blue", rgba[15 * 4 + 2] === 255);
  writeFileSync(new URL("./test-rle32.tga", import.meta.url), tga);
}

// ---- 3. 16-bit (type 2, RGB555) ----
{
  console.log("3) 16-bit RGB555 (type 2)");
  const w = 1, h = 1;
  // RGB555: r=31,g=0,b=0 -> bits: 0111 1100 0000 0000 = 0x7C00
  const header = tgaHeader({ width: w, height: h, imageType: 2, depth: 16 });
  const px = Buffer.from([0x00, 0x7c]);
  const { rgba } = decodeTga(Buffer.concat([header, px]));
  check("red-ish pixel", rgba[0] >= 248 && rgba[0] <= 255 && rgba[1] <= 8 && rgba[2] <= 8);
}

// ---- 4. 8-bit grayscale (type 3) ----
{
  console.log("4) 8-bit grayscale (type 3)");
  const w = 2, h = 1;
  const header = tgaHeader({ width: w, height: h, imageType: 3, depth: 8 });
  const px = Buffer.from([0, 128]);
  const { rgba } = decodeTga(Buffer.concat([header, px]));
  check("gray0=black", rgba[0] === 0 && rgba[1] === 0 && rgba[2] === 0);
  check("gray128", rgba[4] === 128 && rgba[5] === 128 && rgba[6] === 128);
}

// ---- 5. color-mapped (type 1, 24-bit palette) ----
{
  console.log("5) color-mapped (type 1, 24-bit palette)");
  const w = 2, h = 1;
  const header = tgaHeader({ width: w, height: h, imageType: 1, depth: 8, cmType: 1, cmLength: 2, cmEntryBits: 24 });
  const palette = Buffer.from([
    255, 0, 0, // index0 = BGR(0,0,255) -> blue? wait B=255 -> blue
    0, 255, 0 // index1 = BGR(0,255,0) -> green
  ]);
  const indices = Buffer.from([0, 1]);
  const { rgba } = decodeTga(Buffer.concat([header, palette, indices]));
  check("index0=blue", rgba[0] === 0 && rgba[1] === 0 && rgba[2] === 255);
  check("index1=green", rgba[4] === 0 && rgba[5] === 255 && rgba[6] === 0);
}

// ---- 6. PNG encode validity ----
{
  console.log("6) PNG encode");
  const w = 3, h = 2;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = i * 40 % 256;
    rgba[i * 4 + 1] = i * 80 % 256;
    rgba[i * 4 + 2] = i * 120 % 256;
    rgba[i * 4 + 3] = 255;
  }
  const png = encodePng(rgba, w, h);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check("PNG signature", png.subarray(0, 8).equals(sig));
  check("IHDR present", png.subarray(12, 16).toString("ascii") === "IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  check("IHDR dims 3x2", width === 3 && height === 2);
  check("IEND present", png.subarray(png.length - 8, png.length - 4).toString("ascii") === "IEND");
  check("IDAT compressed", png.length < w * h * 4 + 100, `png bytes=${png.length}`);
  writeFileSync(new URL("./test-roundtrip.png", import.meta.url), png);
}

// ---- 7. TGA -> PNG full round trip ----
{
  console.log("7) TGA->PNG full round trip");
  const { rgba, width, height } = decodeTga(readFileSync(new URL("./test-24bit.tga", import.meta.url)));
  const png = encodePng(rgba, width, height);
  check("roundtrip PNG", png.readUInt32BE(16) === 4 && png.readUInt32BE(20) === 4);
  writeFileSync(new URL("./test-from-tga.png", import.meta.url), png);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
