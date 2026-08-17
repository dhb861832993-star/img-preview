/**
 * ImgPreview client half (browser): detects ```img fences in the session
 * DOM and renders local image files inline — with captions, click-to-open
 * full size, and multi-image grids.
 *
 * Registration protocol: window.__ModuleLoader__.load({id, factory}). The
 * factory materializes lazily (on first import by the client cordis Loader)
 * and returns { apply, inject }. apply(ctx) starts the DOM watcher.
 *
 * Fence discovery mirrors pbr-render: it matches standard `md-code-block`
 * surfaces, deepsuite-style `.code-block` / `.code-block-small` surfaces, and
 * a generic label+`<pre>` fallback — any element whose text carries the `img`
 * language tag or a JSON spec with an image `path`/`images` field.
 */

window.__ModuleLoader__.load({
  id: "img-preview",
  factory: (require) => {
    "use strict";

    const FILE_BASE = "/plugins/img-preview/files";
    const LANG = "img";

    /** Encode an absolute image path into a servable URL under the file route. */
    function imageUrlFor(raw) {
      if (raw.startsWith("/") && raw.includes("/files/")) return raw;
      const forward = raw.replace(/\\/g, "/");
      const enc = forward.split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return `${FILE_BASE}/${enc}`;
    }

    /**
     * Parse the spec out of a fence block. Accepts either a bare JSON body or
     * a JSON body wrapped in ```img ... ``` fence markers.
     */
    function parseSpec(body) {
      if (typeof body !== "string") return null;
      let text = body.trim();
      text = text.replace(/^```img\s*/i, "").replace(/\s*```\s*$/, "").trim();
      if (text === "") return null;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
      if (value === null || typeof value !== "object") return null;
      const hasPath = typeof value.path === "string" && value.path !== "";
      const hasImages = Array.isArray(value.images) && value.images.length > 0;
      if (!hasPath && !hasImages) return null;
      return value;
    }

    /** Extract a spec from a block element (banner-mode <pre> first, then full text). */
    function specOfBlock(block) {
      const pre = block.querySelector("pre");
      if (pre) {
        const parsed = parseSpec(pre.textContent ?? "");
        if (parsed !== null) return parsed;
      }
      return parseSpec(block.textContent ?? "");
    }

    /** Whether a block is an img fence (language tag or a parseable spec). */
    function isImgBlock(block) {
      const text = (block.textContent ?? "").trim();
      if (/^```img\b/i.test(text)) return true;
      return specOfBlock(block) !== null;
    }

    /** Normalize one entry into {path, label} with a valid path. */
    function entryOf(item) {
      if (item === null || typeof item !== "object") return null;
      const path = typeof item.path === "string" ? item.path.trim() : "";
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (path === "" && url === "") return null;
      const label = typeof item.label === "string" && item.label !== "" ? item.label : undefined;
      return { path, url, label };
    }

    /**
     * Build the image card DOM. On load error shows a message + raw link.
     * Clicking opens the full-size image in a new tab.
     */
    function buildCard(entry, index) {
      const card = document.createElement("figure");
      card.style.cssText =
        "margin:0;display:flex;flex-direction:column;gap:4px;min-width:0;" +
        (index === 0 ? "" : "max-width:360px;flex:1 1 240px;");
      card.className = "img-preview-card";

      const wrap = document.createElement("div");
      wrap.style.cssText =
        "position:relative;overflow:hidden;border-radius:10px;background:#101216;" +
        "display:flex;align-items:center;justify-content:center;min-height:120px;";

      const img = document.createElement("img");
      img.alt = entry.label ?? "image";
      img.style.cssText =
        "display:block;width:100%;height:auto;max-height:560px;object-fit:contain;cursor:zoom-in;";
      if (index > 0) img.loading = "lazy";

      const fail = () => {
        wrap.innerHTML = "";
        const msg = document.createElement("div");
        msg.style.cssText =
          "padding:14px 16px;color:#f87171;font:12px/1.6 system-ui,monospace;word-break:break-all;";
        msg.textContent = `⚠️ img 加载失败：${entry.path || entry.url}`;
        wrap.appendChild(msg);
      };
      img.addEventListener("error", fail);
      img.addEventListener("click", () => {
        const target = img.currentSrc || img.src;
        window.open(target, "_blank", "noopener");
      });
      wrap.appendChild(img);

      card.appendChild(wrap);

      if (entry.label) {
        const caption = document.createElement("figcaption");
        caption.textContent = entry.label;
        caption.style.cssText =
          "color:var(--dsw-alias-label-secondary,#9aa1ad);font:12px/1.5 system-ui,sans-serif;" +
          "padding:0 2px;word-break:break-word;";
        card.appendChild(caption);
      }
      return card;
    }

    /**
     * Given a detected code block element, insert the image container after
     * it and hide the source.
     */
    function mountTarget(block, spec) {
      const container = document.createElement("div");
      container.className = "img-preview-grid";
      container.style.cssText =
        "display:flex;flex-wrap:wrap;gap:10px;margin:8px 0;align-items:flex-start;";

      const entries = [];
      if (typeof spec.path === "string" && spec.path !== "") {
        entries.push({ path: spec.path, url: spec.url ?? "", label: spec.label });
      } else {
        for (const item of spec.images ?? []) {
          const entry = entryOf(item);
          if (entry !== null) entries.push(entry);
        }
      }

      if (entries.length === 0) {
        const note = document.createElement("div");
        note.style.cssText = "padding:10px 14px;color:#e2a14b;font:12px/1.6 system-ui,monospace;";
        note.textContent = "img 栅栏缺少有效图片路径";
        container.appendChild(note);
        block.after(container);
        block.style.display = "none";
        return;
      }

      entries.forEach((entry, index) => {
        const card = buildCard(entry, index);
        container.appendChild(card);
        const src = entry.url !== "" ? entry.url : imageUrlFor(entry.path);
        const img = card.querySelector("img");
        if (img) img.src = src;
      });

      block.after(container);
      block.style.display = "none";
    }

    // ---- DOM watcher ----
    /** @type {Map<Element, string>} handled blocks → last raw text. */
    const handled = new Map();

    function scan() {
      for (const [el] of handled) {
        if (!el.isConnected) handled.delete(el);
      }
      const candidates = document.querySelectorAll(
        ".md-code-block, .code-block, .code-block-small, pre"
      );
      for (const block of candidates) {
        if (!isImgBlock(block)) continue;
        if (handled.has(block)) continue;

        // Skip while the block is still streaming (incomplete JSON).
        if (block.closest("[data-streaming]") !== null) continue;

        const raw = (block.textContent ?? "").trim();
        const spec = specOfBlock(block);
        if (spec === null) continue;

        handled.set(block, raw);
        mountTarget(block, spec);
      }
    }

    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scan();
      });
    };

    let observer = null;
    let interval = null;

    const apply = () => {
      if (observer) return;
      observer = new MutationObserver(() => schedule());
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      interval = window.setInterval(scan, 1500);
      scan();
    };
    const dispose = () => {
      if (observer) observer.disconnect();
      if (interval !== null) window.clearInterval(interval);
      observer = null;
      interval = null;
      handled.clear();
    };

    return {
      apply,
      inject: ["sessions"],
      dispose,
      renderFence: mountTarget
    };
  }
});
