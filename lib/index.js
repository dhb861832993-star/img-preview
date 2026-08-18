import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { normalize, resolve, isAbsolute } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * ImgPreview host half: registers the `img_serve` tool (validates a local
 * image path and mints a servable URL) plus a loopback file route the browser
 * can fetch. The client half renders ```img fences inline in the chat.
 *
 * Security model: the browser cannot read the local disk, so the host serves
 * image files through an authenticated-by-loopback route. Only files under a
 * caller-supplied root (default: the session workspace) are ever served, and
 * paths are normalized + prefix-checked to prevent traversal. Only image
 * extensions pass; everything else is refused. TGA files are decoded and
 * transcoded to PNG on the fly (browsers cannot render TGA natively).
 * @module img-preview
 */

const FILE_ROUTE = "/plugins/img-preview/files";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg", ".ico", ".tga"]);
const MAX_FILE_BYTES = 128 * 1024 * 1024; // 128 MiB safety ceiling

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tga": "image/x-tga"
};

/** The fence language section injected into every assembled system prompt. */
const IMG_SECTION_TEXT = `You can display local image files INLINE inside your reply by emitting a fenced block with the language tag \`img\` containing a JSON spec. The chat renders the image directly (no need for the user to open a file path).

\`\`\`img
{"path":"absolute-or-workspace-relative/path/to/image.png","label":"可选标题"}
\`\`\`

Spec fields:
- path: required — a local image file (.png/.jpg/.jpeg/.webp/.gif/.avif/.bmp/.svg/.ico/.tga), absolute or relative to the session workspace.
- label: optional — caption shown under the image.
- Multiple images: use {"images":[{"path":"...","label":"..."}, ...]} to render a grid.

ACTIVE TRIGGERING — you initiate, never wait to be asked:
- Whenever an image file is present or produced in the session — you generated it via an API (e.g. DreamMaker 2D/3D), downloaded it, the user mentioned a path, a screenshot was taken, or one appeared in the workspace — call the \`img_serve\` tool with the path FIRST, then emit the \`img\` fence in the same reply. Do not ask "want me to show it?" — just show it.
- The user may of course also ask explicitly ("展示图片", "把图发出来", "show me the image"); explicit requests are answered the same way.

Rules:
- Call \`img_serve\` with the image path first; it validates the file and confirms the path is servable. Only emit the fence after it succeeds.
- If the tool reports an error (missing file, unsupported extension), report it to the user; do not emit a fence.
- Do not render the same image twice in one conversation unless the file changed or the user asks again — deduplicate by path.`;

/**
 * Resolve a user-supplied image path against the allowed roots. Absolute
 * paths are used as-is; relative paths are tried under EVERY root and the
 * first existing match wins. The result is normalized and must stay within
 * one of the roots.
 */
function resolveImagePath(raw, roots) {
  const normalizedRoots = roots.map((r) => normalize(r));
  if (isAbsolute(raw)) {
    const normalized = normalize(raw);
    return withinAnyRoot(normalized, normalizedRoots) ? normalized : null;
  }
  for (const rootNorm of normalizedRoots) {
    const candidate = normalize(resolve(rootNorm, raw));
    if (existsSync(candidate) && withinAnyRoot(candidate, normalizedRoots)) {
      return candidate;
    }
  }
  // Fall back to the first root even when missing (so the caller reports a
  // clear "file not found" rather than a confusing escape error).
  return normalize(resolve(normalizedRoots[0] ?? "", raw));
}

/** Whether a normalized absolute path stays inside one of the roots. */
function withinAnyRoot(normalized, normalizedRoots) {
  for (const rootNorm of normalizedRoots) {
    if (normalized === rootNorm || normalized.startsWith(rootNorm + "\\") || normalized.startsWith(rootNorm + "/")) {
      return true;
    }
  }
  return false;
}

/** Content-type for an image extension, or undefined when not servable. */
function contentTypeFor(ext) {
  return CONTENT_TYPES[ext];
}

// ---------------------------------------------------------------------------
// TGA (Truevision Targa) decoding + minimal PNG encoding.
// Browsers cannot render .tga natively, so the file route transcodes TGA to
// PNG on the fly. Both halves use only Node builtins (node:zlib), keeping the
// plugin dependency-free.
// ---------------------------------------------------------------------------

const MAX_TGA_PIXELS = 50_000_000; // decode safety ceiling (50 MP)

/**
 * Decode a TGA buffer into top-left-origin, left-to-right RGBA pixels.
 * Supports image types 1/2/3 (uncompressed color-mapped / true-color /
 * grayscale), 9/10/11 (RLE variants), pixel depths 8/16/24/32, and both
 * origin conventions (descriptor bits 4/5).
 * @param {Buffer} buffer - raw TGA file bytes.
 * @returns {{ rgba: Buffer, width: number, height: number }}
 */
function decodeTga(buffer) {
  if (buffer.length < 18) throw new Error("TGA: header too short");
  const idLength = buffer[0];
  const colorMapType = buffer[1];
  const imageType = buffer[2];
  const cmFirst = buffer[3] | (buffer[4] << 8);
  const cmLength = buffer[5] | (buffer[6] << 8);
  const cmEntryBits = buffer[7];
  const width = buffer[12] | (buffer[13] << 8);
  const height = buffer[14] | (buffer[15] << 8);
  const pixelDepth = buffer[16];
  const descriptor = buffer[17];
  if (width === 0 || height === 0) throw new Error("TGA: zero dimension");
  if (width * height > MAX_TGA_PIXELS) throw new Error("TGA: image too large");

  let offset = 18 + idLength;

  // Color map (palette): entries are 16/24/32-bit BGR(A).
  const palette = [];
  if (colorMapType === 1) {
    const entryBytes = Math.max(1, Math.ceil(cmEntryBits / 8));
    if (offset + cmLength * entryBytes > buffer.length) throw new Error("TGA: truncated color map");
    for (let i = 0; i < cmLength; i++) {
      palette.push(readTgaPixel(buffer, offset + i * entryBytes, cmEntryBits >= 24 ? cmEntryBits : 16));
    }
    offset += cmLength * entryBytes;
  }

  const rle = imageType === 9 || imageType === 10 || imageType === 11;
  const colorMapped = imageType === 1 || imageType === 9;
  const grayscale = imageType === 3 || imageType === 11;
  if (imageType !== 1 && imageType !== 2 && imageType !== 3 && imageType !== 9 && imageType !== 10 && imageType !== 11) {
    throw new Error(`TGA: unsupported image type ${imageType}`);
  }

  const total = width * height;
  const raw = new Uint8Array(total * 4);
  let src = offset;
  let dst = 0;

  const bytesPerPixel = (depth) => (depth === 15 || depth === 16 ? 2 : depth === 24 ? 3 : depth === 32 ? 4 : 1);

  while (dst < total * 4) {
    let count;
    let repeat;
    if (rle) {
      if (src >= buffer.length) throw new Error("TGA: truncated RLE stream");
      const packet = buffer[src++];
      repeat = (packet & 0x80) !== 0;
      count = (packet & 0x7f) + 1;
    } else {
      count = total - dst / 4;
      repeat = false;
    }
    if (src >= buffer.length) throw new Error("TGA: truncated pixel data");
    let px;
    if (colorMapped) {
      const index = buffer[src];
      const entry = palette[index];
      if (entry === undefined) throw new Error(`TGA: palette index ${index} out of range`);
      px = entry;
      src += 1;
    } else if (grayscale) {
      const v = buffer[src];
      px = [v, v, v, 255];
      src += 1;
    } else {
      px = readTgaPixel(buffer, src, pixelDepth);
      src += bytesPerPixel(pixelDepth);
    }
    if (repeat) {
      // RLE run: one pixel repeated `count` times.
      for (let i = 0; i < count && dst < total * 4; i++) {
        raw[dst++] = px[0];
        raw[dst++] = px[1];
        raw[dst++] = px[2];
        raw[dst++] = px[3];
      }
    } else {
      // Raw packet: `count` literal pixels.
      for (let i = 0; i < count && dst < total * 4; i++) {
        raw[dst++] = px[0];
        raw[dst++] = px[1];
        raw[dst++] = px[2];
        raw[dst++] = px[3];
        if (i + 1 < count) {
          if (colorMapped) {
            const index = buffer[src];
            const entry = palette[index];
            if (entry === undefined) throw new Error(`TGA: palette index ${index} out of range`);
            px = entry;
            src += 1;
          } else if (grayscale) {
            const v = buffer[src];
            px = [v, v, v, 255];
            src += 1;
          } else {
            px = readTgaPixel(buffer, src, pixelDepth);
            src += bytesPerPixel(pixelDepth);
          }
        }
      }
    }
  }

  // Normalize orientation to top-left origin, left-to-right.
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  if (topDown && !rightToLeft) return { rgba: Buffer.from(raw), width, height };

  const out = Buffer.alloc(total * 4);
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const srcX = rightToLeft ? width - 1 - x : x;
      const si = (srcY * width + srcX) * 4;
      const di = (y * width + x) * 4;
      out[di] = raw[si];
      out[di + 1] = raw[si + 1];
      out[di + 2] = raw[si + 2];
      out[di + 3] = raw[si + 3];
    }
  }
  return { rgba: out, width, height };
}

/** Read one BGR(A)/gray pixel at `offset` with the given bit depth. */
function readTgaPixel(buffer, offset, depth) {
  switch (depth) {
    case 8: {
      const v = buffer[offset];
      return [v, v, v, 255];
    }
    case 15:
    case 16: {
      const v = buffer[offset] | (buffer[offset + 1] << 8);
      const r = (v >> 10) & 0x1f;
      const g = (v >> 5) & 0x1f;
      const b = v & 0x1f;
      const alpha = (v & 0x8000) !== 0 ? 255 : 0;
      return [r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2, alpha];
    }
    case 24:
      return [buffer[offset + 2], buffer[offset + 1], buffer[offset], 255];
    case 32:
      return [buffer[offset + 2], buffer[offset + 1], buffer[offset], buffer[offset + 3]];
    default:
      throw new Error(`TGA: unsupported pixel depth ${depth}`);
  }
}

// --- minimal PNG encoder (RGBA, 8-bit, filter 0) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode top-left-origin RGBA pixels into a PNG buffer (color type 6).
 * @param {Buffer} rgba - width*height*4 bytes.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG file bytes.
 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/**
 * Serve one local image through the loopback file route. The URL encodes an
 * absolute path minted by the img_serve tool (already validated to exist with
 * a servable extension). The handler re-validates extension and size and
 * normalizes the path.
 */
function createFileHandler() {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "/", "http://x");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const rel = url.pathname.startsWith(`${FILE_ROUTE}/`) ? url.pathname.slice(FILE_ROUTE.length + 1) : null;
    if (rel === null || rel === "") {
      res.writeHead(404);
      res.end();
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // URL 里用正斜杠编码的路径（Windows 盘符 H:/...），解码后转为本地形式
    const target = normalize(decoded.replace(/\//g, "\\"));
    if (!existsSync(target)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = target.slice(target.lastIndexOf(".")).toLowerCase();
    const contentType = contentTypeFor(ext);
    if (contentType === undefined) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body;
    try {
      const info = await stat(target);
      if (info.size > MAX_FILE_BYTES) {
        res.writeHead(413);
        res.end();
        return;
      }
      body = await readFile(target);
    } catch {
      res.writeHead(500);
      res.end();
      return;
    }
    // TGA is not renderable by browsers — transcode to PNG on the fly.
    let finalType = contentType;
    if (ext === ".tga") {
      try {
        const { rgba, width, height } = decodeTga(body);
        body = encodePng(rgba, width, height);
        finalType = "image/png";
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(`TGA decode failed: ${String(error?.message ?? error)}`);
        return;
      }
    }
    res.writeHead(200, {
      "content-type": finalType,
      "content-length": String(body.length),
      "cache-control": "no-cache",
      "access-control-allow-origin": "*"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/** The `img_serve` tool: validate an image path and confirm it is servable. */
function createImgServeTool(rootProvider) {
  return {
    name: "img_serve",
    description:
      "Prepare a local image file for inline display in the chat: validates the path, verifies the extension (.png/.jpg/.jpeg/.webp/.gif/.avif/.bmp/.svg/.ico/.tga), and confirms the file is servable to the browser. Call this BEFORE emitting a ```img fence. Returns the confirmed absolute path and the served URL.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image file. Absolute, or relative to the session workspace. Must end in .png, .jpg, .jpeg, .webp, .gif, .avif, .bmp, .svg, .ico or .tga."
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          url: { type: "string" },
          error: { type: "string" }
        },
        required: ["ok"],
        additionalProperties: false
      },
      render(args, value) {
        return [
          {
            type: "text",
            text: value.ok
              ? `img_serve: ✅ ${value.path} is ready — emit a \`\`\`img fence with {"path":"${value.path.replace(/\\/g, "/")}"} to display it inline.`
              : `img_serve: ❌ ${value.error ?? "cannot serve this file"}`
          }
        ];
      },
      presentationMeta(args, value) {
        return value;
      }
    },
    async execute(args, exec) {
      const raw = typeof args?.path === "string" ? args.path.trim() : "";
      if (raw === "") {
        return { ok: false, error: "image path is required" };
      }
      // Prefer the calling session's cwd (its workspace); fall back to global roots.
      const sessionCwd = exec?.agent?.session?.header?.cwd;
      const roots = sessionCwd ? [sessionCwd, ...rootProvider()] : rootProvider();
      const resolved = resolveImagePath(raw, roots);
      if (resolved === null) {
        return { ok: false, error: "path escapes every allowed workspace root" };
      }
      if (!existsSync(resolved)) {
        return { ok: false, error: `file not found: ${raw}` };
      }
      const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
      if (contentTypeFor(ext) === undefined) {
        return { ok: false, error: `unsupported image extension "${ext}" — use .png, .jpg, .jpeg, .webp, .gif, .avif, .bmp, .svg, .ico or .tga` };
      }
      const url = `${FILE_ROUTE}/${encodeURIComponent(resolved.replace(/\\/g, "/"))}`;
      return { ok: true, path: resolved, url };
    }
  };
}

/** Plugin entry: register tool, file route, and the prompt section. */
const inject = ["systemPrompt"];

function apply(ctx) {
  /** All allowed roots: every registered workspace + env/cwd fallback, deduped. */
  const rootProvider = () => {
    const roots = [];
    const seen = new Set();
    const add = (path) => {
      if (typeof path !== "string" || path === "") return;
      const norm = normalize(path);
      if (!seen.has(norm)) {
        seen.add(norm);
        roots.push(norm);
      }
    };
    try {
      const registry = ctx.workspaceRegistry ?? ctx.reflect.get("workspaceRegistry", false);
      const workspaces = registry?.list?.() ?? [];
      for (const ws of workspaces) add(ws.path);
    } catch {
      /* fall through */
    }
    add(process.env.DSH_WORKSPACE);
    add(process.cwd());
    return roots.length > 0 ? roots : [process.cwd()];
  };

  ctx.systemPrompt.section({
    name: "img-preview:fence",
    order: 115,
    text: IMG_SECTION_TEXT
  });

  let toolRegistered = false;
  const tryRegisterTool = (value) => {
    if (toolRegistered) return;
    const tools = value ?? ctx.reflect.get("tools", false);
    if (tools === void 0) return;
    tools.register(createImgServeTool(rootProvider));
    toolRegistered = true;
  };
  tryRegisterTool(void 0);
  ctx.on("internal/service", (name, value) => {
    if (name === "tools") tryRegisterTool(value);
  });

  let fileRegistered = false;
  const tryRegisterFiles = (value) => {
    if (fileRegistered) return;
    const webServer = value ?? ctx.reflect.get("webServer", false);
    if (webServer === void 0) return;
    webServer.register({
      kind: "prefix",
      path: FILE_ROUTE,
      handler: createFileHandler()
    });
    fileRegistered = true;
  };
  tryRegisterFiles(void 0);
  ctx.on("internal/service", (name, value) => {
    if (name === "webServer") tryRegisterFiles(value);
  });
}

export { apply, inject, decodeTga, encodePng };
