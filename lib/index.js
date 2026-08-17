import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { normalize, resolve, isAbsolute } from "node:path";

/**
 * ImgPreview host half: registers the `img_serve` tool (validates a local
 * image path and mints a servable URL) plus a loopback file route the browser
 * can fetch. The client half renders ```img fences inline in the chat.
 *
 * Security model: the browser cannot read the local disk, so the host serves
 * image files through an authenticated-by-loopback route. Only files under a
 * caller-supplied root (default: the session workspace) are ever served, and
 * paths are normalized + prefix-checked to prevent traversal. Only image
 * extensions pass; everything else is refused.
 * @module img-preview
 */

const FILE_ROUTE = "/plugins/img-preview/files";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg", ".ico"]);
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
  ".ico": "image/x-icon"
};

/** The fence language section injected into every assembled system prompt. */
const IMG_SECTION_TEXT = `You can display local image files INLINE inside your reply by emitting a fenced block with the language tag \`img\` containing a JSON spec. The chat renders the image directly (no need for the user to open a file path).

\`\`\`img
{"path":"absolute-or-workspace-relative/path/to/image.png","label":"可选标题"}
\`\`\`

Spec fields:
- path: required — a local image file (.png/.jpg/.jpeg/.webp/.gif/.avif/.bmp/.svg/.ico), absolute or relative to the session workspace.
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
    res.writeHead(200, {
      "content-type": contentType,
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
      "Prepare a local image file for inline display in the chat: validates the path, verifies the extension (.png/.jpg/.jpeg/.webp/.gif/.avif/.bmp/.svg/.ico), and confirms the file is servable to the browser. Call this BEFORE emitting a ```img fence. Returns the confirmed absolute path and the served URL.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image file. Absolute, or relative to the session workspace. Must end in .png, .jpg, .jpeg, .webp, .gif, .avif, .bmp, .svg or .ico."
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
              ? `img_serve: ✅ ${value.path} is ready — emit a \`\`\`img fence with {"path":"${value.path}"} to display it inline.`
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
        return { ok: false, error: `unsupported image extension "${ext}" — use .png, .jpg, .jpeg, .webp, .gif, .avif, .bmp, .svg or .ico` };
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

export { apply, inject };
