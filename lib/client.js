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
        // Tolerate Windows backslash paths ("H:\dir\img.png") that would be
        // invalid JSON escapes: normalize stray backslashes to forward slashes
        // and retry once before giving up.
        const tolerated = text.replace(/\\(?![\\"bfnrtu])/g, "/");
        try {
          value = JSON.parse(tolerated);
        } catch {
          return null;
        }
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
     * Standalone lightbox viewer: opens an image in a fullscreen overlay with
     * free zoom (wheel, around cursor) and pan (drag). Double-click on the
     * thumbnail opens it; inside, double-click toggles between 100% and a
     * zoomed view. ESC / × / backdrop click closes.
     * @param {string} src - servable image URL.
     * @param {string} [label] - optional caption.
     */
    function openLightbox(src, label) {
      const overlay = document.createElement("div");
      overlay.className = "img-preview-lightbox";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,0.94);" +
        "display:flex;flex-direction:column;align-items:stretch;";

      const stage = document.createElement("div");
      stage.style.cssText =
        "position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;cursor:grab;";

      const img = document.createElement("img");
      img.src = src;
      img.alt = label ?? "image";
      img.draggable = false;
      img.style.cssText =
        "position:absolute;left:50%;top:50%;max-width:none;max-height:none;" +
        "user-select:none;-webkit-user-drag:none;will-change:transform;";

      const hint = document.createElement("div");
      hint.style.cssText =
        "position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:4px 12px;" +
        "border-radius:999px;background:rgba(0,0,0,0.55);color:#c9ced8;font:12px/1.6 system-ui,sans-serif;" +
        "pointer-events:none;white-space:nowrap;";
      hint.textContent = "滚轮缩放 · 拖拽平移 · 双击切换 · ESC 关闭";
      stage.appendChild(img);
      stage.appendChild(hint);

      // ---- zoom / pan state ----
      let scale = 1;
      let tx = 0;
      let ty = 0;
      const MIN_SCALE = 0.05;
      const MAX_SCALE = 20;

      const apply = () => {
        img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${scale})`;
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      };

      /** Zoom by `factor` keeping the stage-space point (px, py) fixed. */
      const zoomAt = (factor, px, py) => {
        const rect = stage.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const sx = px === undefined ? cx : px - rect.left;
        const sy = py === undefined ? cy : py - rect.top;
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
        const r = next / scale;
        tx = (sx - cx) * (1 - r) + tx * r;
        ty = (sy - cy) * (1 - r) + ty * r;
        scale = next;
        apply();
      };

      /** Fit the image into the viewport (aspect-preserving), centered. */
      const fit = () => {
        const rect = stage.getBoundingClientRect();
        const nw = img.naturalWidth || rect.width;
        const nh = img.naturalHeight || rect.height;
        if (nw === 0 || nh === 0) return;
        scale = Math.min(rect.width / nw, rect.height / nh, 1);
        tx = 0;
        ty = 0;
        apply();
      };
      const reset = () => {
        scale = 1;
        tx = 0;
        ty = 0;
        apply();
      };

      // wheel: zoom around the cursor (prevent page scroll).
      stage.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
        },
        { passive: false }
      );

      // drag to pan.
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let origTx = 0;
      let origTy = 0;
      stage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        origTx = tx;
        origTy = ty;
        stage.style.cursor = "grabbing";
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        tx = origTx + (e.clientX - startX);
        ty = origTy + (e.clientY - startY);
        apply();
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        stage.style.cursor = "grab";
      };
      stage.addEventListener("pointerup", endDrag);
      stage.addEventListener("pointercancel", endDrag);

      // double-click: toggle 100% <-> 2.5x.
      stage.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (Math.abs(scale - 1) < 0.01) {
          zoomAt(2.5, e.clientX, e.clientY);
        } else {
          reset();
        }
      });

      // ---- toolbar ----
      const bar = document.createElement("div");
      bar.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:10px 14px;flex-wrap:wrap;" +
        "background:rgba(20,22,28,0.92);border-top:1px solid rgba(255,255,255,0.08);";

      const btnStyle =
        "border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);" +
        "color:#e6e9ee;border-radius:8px;padding:5px 12px;font:13px/1.4 system-ui,sans-serif;" +
        "cursor:pointer;";
      const makeBtn = (text, onClick, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = title ?? "";
        b.style.cssText = btnStyle;
        b.addEventListener("click", onClick);
        return b;
      };

      const zoomLabel = document.createElement("span");
      zoomLabel.style.cssText = "color:#c9ced8;font:12px/1.4 system-ui,monospace;min-width:44px;text-align:center;";

      const title = document.createElement("span");
      title.style.cssText = "color:#9aa1ad;font:12px/1.4 system-ui,sans-serif;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
      title.textContent = label ?? src;

      bar.appendChild(title);
      bar.appendChild(makeBtn("−", () => zoomAt(1 / 1.3), "缩小"));
      bar.appendChild(zoomLabel);
      bar.appendChild(makeBtn("＋", () => zoomAt(1.3), "放大"));
      bar.appendChild(makeBtn("适应", fit, "适应窗口"));
      bar.appendChild(makeBtn("100%", reset, "原始大小"));
      bar.appendChild(makeBtn("原图", () => window.open(src, "_blank", "noopener"), "新标签页打开原图"));
      bar.appendChild(makeBtn("✕", close, "关闭 (ESC)"));

      overlay.appendChild(stage);
      overlay.appendChild(bar);
      document.body.appendChild(overlay);

      // ---- close ----
      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
      }
      function onKey(e) {
        if (e.key === "Escape") close();
      }
      document.addEventListener("keydown", onKey);

      // backdrop click closes (ignore clicks on the image/toolbar).
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
      });

      img.addEventListener("load", fit);
      // initial paint: wait for load (or immediate if cached).
      if (img.complete && img.naturalWidth > 0) fit();
      apply();
    }

    /**
     * Build the image card DOM. On load error shows a message + raw link.
     * Double-click opens the standalone lightbox viewer (free zoom/pan).
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
      img.title = "双击查看大图（滚轮缩放 · 拖拽平移）";
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
      img.addEventListener("dblclick", () => {
        const target = img.currentSrc || img.src;
        if (target) openLightbox(target, entry.label);
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
