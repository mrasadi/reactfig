import { resolveComponentBoundary } from "@reactfig/analyzer";

/**
 * Builds the Interactive Capture overlay as a plain JS source string,
 * meant to be run via Playwright's `page.addInitScript` (so it survives
 * full navigations/reloads) AND `page.evaluate` once immediately after
 * attaching (so it's also present on the page already open when the
 * developer's session starts — `addInitScript` alone only affects
 * *future* navigations, not the current document).
 *
 * Embeds `resolveComponentBoundary`'s own source via `.toString()` rather
 * than reimplementing the fiber-walk a fourth time — this is the single
 * source of truth for "what DOM node is the real component boundary",
 * shared between this overlay and @reactfig/analyzer's own tests, kept in
 * sync automatically because it's literally the same function body.
 *
 * Deliberately does NOT capture a DOM snapshot or screenshot itself —
 * those need Playwright's Node-side API (`Locator.screenshot()`,
 * `page.evaluate(collectDomSnapshot, ...)`), not something achievable from
 * inside the page's own JS context. This script only resolves a target
 * and its metadata, then hands a small payload to Node via the exposed
 * `__reactfigConfirmSelection`/`__reactfigRemoveSelection` functions
 * (collectionBrowser.ts) — Node does the actual capture and owns all
 * persistence, per the "browser must not own collection persistence" rule
 * (docs/architecture.md, Interactive Capture).
 *
 * Idempotent: re-running this script (e.g. once via addInitScript on
 * load, once via an explicit evaluate right after) is a no-op the second
 * time, guarded by `window.__reactfigOverlayInstalled`.
 *
 * IMPORTANT — overlay visibility (third pass): two earlier approaches
 * (a zero-size fixed host with fixed children; a full-viewport fixed host
 * with absolute/fixed children plus a forced reflow) both still failed to
 * paint on some real target apps. Both were fighting the same class of
 * problem from the wrong side: a `position: fixed` element can still be
 * clipped by an ancestor's `overflow`/stacking context even though its
 * *layout position* resolves against the viewport — a well-known
 * cross-browser quirk, and any app the overlay is injected into is, by
 * definition, arbitrary CSS we don't control.
 *
 * The actual fix is to stop depending on `position: fixed` escaping
 * ancestor CSS at all: when the browser's top-layer Popover API is
 * available (`HTMLElement.prototype.showPopover`, supported in current
 * Chromium/Firefox/Safari — i.e. any Playwright-launched browser this
 * feature realistically runs against), the host is promoted into the
 * **top layer** via `popover="manual"` + `showPopover()`. A top-layer
 * element is, by spec, painted above the entire document and is
 * completely exempt from every ancestor's `overflow`, `clip`,
 * `z-index`/stacking context, and `transform` — there is no CSS the
 * target app can write that clips or restacks it. This is the same
 * mechanism `<dialog>`'s native backdrop and browser-native `<select>`
 * dropdowns rely on. `position: fixed` + a very high `z-index` is kept
 * as an explicit fallback for a browser without Popover support, and as
 * the host's own internal layout (the popover UA stylesheet still needs
 * our sizing rules to fill the viewport rather than shrink-wrap+center).
 *
 * A one-time diagnostic `console.log` (clearly prefixed `[reactfig]`,
 * dev-tool-only, not something a shipped product would do) reports
 * whether the host actually attached, whether the popover promotion
 * succeeded, and its resulting bounding rect — so if this still doesn't
 * render on some app, there's now an actual data point to debug from
 * instead of another guess.
 */
/**
 * Bumped whenever the overlay's UI/behavior changes. The overlay script
 * is idempotent per page (a second injection is skipped), so without a
 * version a page that already ran an older build would silently keep
 * showing the old UI after an upgrade — see the guard at the top of the
 * generated script. Also logged on injection and in the on-page
 * diagnostic so it's obvious which build is actually running.
 */
export const OVERLAY_VERSION = "2";

export function buildOverlayScript(): string {
  const resolveComponentBoundarySource = resolveComponentBoundary.toString();

  return `
(function () {
  var OVERLAY_VERSION = "${OVERLAY_VERSION}";
  if (window.__reactfigOverlayInstalled === OVERLAY_VERSION) return;
  if (window.__reactfigOverlayInstalled) {
    // An OLDER overlay build is still alive in this page (it has no
    // teardown hook, and its own timer re-attaches its host if removed),
    // so hide it instead of fighting it, then install this build.
    var staleHosts = document.querySelectorAll("[data-reactfig-overlay-host]");
    for (var i = 0; i < staleHosts.length; i++) {
      staleHosts[i].style.setProperty("display", "none", "important");
    }
  }
  window.__reactfigOverlayInstalled = OVERLAY_VERSION;

  var resolveComponentBoundary = (${resolveComponentBoundarySource});
  var MARKER_ATTR = "data-reactfig-pending-selection";

  var state = {
    active: false,
    pending: null, // resolved ComponentBoundaryResult while previewing, before confirm
    pendingOutputFormat: "rfd", // Output Intent select's current value — see buildOutputSelect/confirmPending
    outputMenuOpen: false, // whether the settings-area output select's option list is expanded
    markingDone: false, // true between clicking Done/Continue and the browser closing — see renderPanel/__reactfigMarkDone
    selections: [], // [{selectionId, order, status, componentPath, url}], pushed from Node via applyState
    minimized: false,
    panelPos: null // {left, top} in px once the developer has dragged the panel; null = default bottom-right
  };

  // --- Shadow-DOM-isolated UI root, promoted to the browser's top layer
  var host = document.createElement("div");
  host.setAttribute("data-reactfig-overlay-host", "1");
  var supportsPopover = typeof host.showPopover === "function";
  if (supportsPopover) {
    host.setAttribute("popover", "manual");
  }
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.margin = "0";
  host.style.inset = "0";
  host.style.top = "0";
  host.style.right = "0";
  host.style.bottom = "0";
  host.style.left = "0";
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.maxWidth = "none";
  host.style.maxHeight = "none";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  host.style.background = "transparent";
  host.style.border = "none";

  var attachHost = function () {
    if (document.documentElement && !document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
    }
    if (supportsPopover) {
      try {
        host.showPopover();
      } catch (err) {
        // Already open, or briefly not connected on a retry — both safe
        // to ignore; the next attachHost() tick (see setInterval below)
        // will settle it.
      }
    }
    // Forces a synchronous layout flush — belt-and-suspenders against
    // the host being attached/shown but not yet actually painted.
    void host.offsetHeight;
  };
  attachHost();
  var shadow = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent =
    ':host{all:initial}' +
    '.panel{position:relative;bottom:0px;right:0px;width:280px;max-height:60vh;overflow:auto;' +
    'background:#1b1b1f;color:#f4f4f5;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:10px 12px;pointer-events:auto}' +
    '.panel.minimized{max-height:none;overflow:visible;padding:6px 8px}' +
    '.row{display:flex;align-items:center;gap:8px;margin-bottom:6px}' +
    '.row.header{margin-bottom:0}' +
    '.grip{cursor:move;opacity:.5;padding:0 2px;user-select:none;touch-action:none}' +
    '.grip:hover{opacity:.9}' +
    '.title{font-weight:600;font-size:12px;white-space:nowrap}' +
    '.spacer{flex:1}' +
    '.btn{background:#2c2c33;color:#f4f4f5;border:1px solid #3a3a42;border-radius:6px;padding:4px 8px;' +
    'font-size:11px;cursor:pointer;flex-shrink:0}' +
    '.btn:hover{background:#3a3a42}' +
    '.btn.active{background:#4f7cff;border-color:#4f7cff}' +
    '.btn.danger{color:#ff8080}' +
    '.btn.primary{background:#2f6dfb;border-color:#2f6dfb;color:#fff}' +
    '.btn.icon{padding:2px 6px;line-height:1}' +
    '.body{margin-top:8px}' +
    '.hint{opacity:.6;font-style:italic;font-size:11px;line-height:1.4}' +
    '.log{margin-top:6px;border-top:1px solid #333;padding-top:6px}' +
    '.entry{display:flex;justify-content:space-between;gap:6px;padding:3px 0}' +
    '.entry .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.entry.removed{opacity:.45;text-decoration:line-through}' +
    '.preview{position:fixed;width:220px;background:#1b1b1f;color:#f4f4f5;' +
    'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border-radius:10px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.35);padding:10px 12px;pointer-events:auto}' +
    '.preview .actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}' +
    '.highlight{position:fixed;pointer-events:none;border:2px solid #4f7cff;background:rgba(79,124,255,.12);' +
    'border-radius:2px}' +
    '.settings{margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #333}' +
    '.field-label{display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55;margin-bottom:4px}' +
    '.select{position:relative}' +
    '.select-trigger{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;' +
    'background:#2c2c33;border:1px solid #3a3a42;border-radius:6px;padding:6px 8px;cursor:pointer;' +
    'color:#f4f4f5;font-size:12px}' +
    '.select-trigger:hover{background:#34343c}' +
    '.select-trigger:focus-visible{outline:2px solid #4f7cff;outline-offset:1px}' +
    '.select.open .select-trigger{border-color:#4f7cff}' +
    '.select-value{font-weight:600}' +
    '.select-hint{opacity:.55;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.chevron{margin-left:auto;opacity:.7;font-size:10px;transition:transform .12s}' +
    '.select.open .chevron{transform:rotate(180deg)}' +
    '.select-menu{display:none;margin-top:4px;padding:4px;background:#23232a;border:1px solid #3a3a42;border-radius:6px}' +
    '.select.open .select-menu{display:block}' +
    '.select-option{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;' +
    'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:12px;color:#f4f4f5}' +
    '.select-option:hover,.select-option:focus-visible{background:#34343c}' +
    '.select-option[aria-selected="true"]{background:rgba(79,124,255,.18)}' +
    '.select-check{width:12px;flex-shrink:0;color:#4f7cff;font-size:11px;visibility:hidden}' +
    '.select-option[aria-selected="true"] .select-check{visibility:visible}' +
    '.chip{background:rgba(79,124,255,.18);color:#9db7ff;border-radius:4px;padding:1px 6px;font-size:10px;' +
    'font-weight:600;letter-spacing:.04em;flex-shrink:0}' +
    '.dim{opacity:.7}';
  shadow.appendChild(style);

  var panel = document.createElement("div");
  panel.className = "panel";
  shadow.appendChild(panel);

  var highlightBox = document.createElement("div");
  highlightBox.className = "highlight";
  highlightBox.style.display = "none";
  shadow.appendChild(highlightBox);

  var previewBox = document.createElement("div");
  previewBox.className = "preview";
  previewBox.style.display = "none";
  shadow.appendChild(previewBox);

  function renderRect(el, box) {
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    box.style.display = "block";
  }

  // Positions the preview right next to the panel's CURRENT on-screen
  // spot (which may have been dragged anywhere) instead of a fixed
  // default corner: prefers just to the panel's left, falls back to its
  // right, and finally stacks above it if neither side has room —
  // always clamped to stay fully inside the viewport.
  function positionPreviewNextToPanel() {
    var panelRect = panel.getBoundingClientRect();
    var gap = 12;
    var edge = 8;
    var previewWidth = previewBox.offsetWidth || 220;
    var previewHeight = previewBox.offsetHeight || 120;

    var left = panelRect.left - previewWidth - gap;
    var top = panelRect.top;

    if (left < edge) {
      left = panelRect.right + gap;
    }
    if (left + previewWidth > window.innerWidth - edge) {
      left = Math.min(Math.max(panelRect.left, edge), window.innerWidth - previewWidth - edge);
      top = panelRect.top - previewHeight - gap;
    }

    left = Math.min(Math.max(left, edge), Math.max(edge, window.innerWidth - previewWidth - edge));
    top = Math.min(Math.max(top, edge), Math.max(edge, window.innerHeight - previewHeight - edge));

    previewBox.style.left = left + "px";
    previewBox.style.top = top + "px";
    previewBox.style.right = "auto";
    previewBox.style.bottom = "auto";
  }

  // --- Drag-to-move (grip-initiated, pointer events for mouse+touch) --
  var dragState = null;

  function applyPanelPosition() {
    if (!state.panelPos) return;
    panel.style.left = state.panelPos.left + "px";
    panel.style.top = state.panelPos.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function beginDrag(e) {
    if (typeof e.button === "number" && e.button !== 0) return;
    var rect = panel.getBoundingClientRect();
    dragState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
    if (e.target.setPointerCapture) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    }
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    var left = dragState.startLeft + (e.clientX - dragState.startX);
    var top = dragState.startTop + (e.clientY - dragState.startY);
    var maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    var maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    state.panelPos = { left: Math.min(Math.max(left, 0), maxLeft), top: Math.min(Math.max(top, 0), maxTop) };
    applyPanelPosition();
    if (state.pending) positionPreviewNextToPanel();
  }

  function endDrag() {
    dragState = null;
  }

  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  // --- Output format select ---------------------------------------
  // Custom listbox (button trigger + inline option list) instead of the
  // browser-native <select>, so it matches the rest of the panel and
  // lives in the always-visible settings area rather than the
  // per-selection preview. The list expands inside the panel's own flow
  // on purpose: an absolutely positioned dropdown would be clipped by
  // the panel's overflow:auto / max-height.
  var OUTPUT_OPTIONS = [
    { value: "rfd", label: "RFD", hint: "Figma import artifact" },
    { value: "json", label: "JSON", hint: "Design IR document" },
    { value: "svg", label: "SVG", hint: "Static vector render" },
    { value: "html", label: "HTML", hint: "Standalone HTML page" }
  ];
  var outputSelectEl = null;
  var focusOutputTriggerAfterRender = false;

  function currentOutputOption() {
    for (var i = 0; i < OUTPUT_OPTIONS.length; i++) {
      if (OUTPUT_OPTIONS[i].value === state.pendingOutputFormat) return OUTPUT_OPTIONS[i];
    }
    return OUTPUT_OPTIONS[0];
  }

  // Toggles the option list in place (no panel re-render), so a click
  // on another panel button while the list is open is never swallowed
  // by a DOM rebuild between pointerdown and click.
  function setOutputMenuOpen(open) {
    state.outputMenuOpen = open;
    if (!outputSelectEl) return;
    outputSelectEl.classList.toggle("open", open);
    var trigger = outputSelectEl.querySelector(".select-trigger");
    if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function chooseOutputFormat(value) {
    state.pendingOutputFormat = value;
    state.outputMenuOpen = false;
    focusOutputTriggerAfterRender = true;
    renderPanel();
    if (state.pending) renderPreview();
  }

  function buildOutputSelect() {
    var current = currentOutputOption();

    var wrap = document.createElement("div");
    wrap.className = "select" + (state.outputMenuOpen ? " open" : "");
    outputSelectEl = wrap;

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "select-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", state.outputMenuOpen ? "true" : "false");
    trigger.setAttribute("aria-label", "Output format: " + current.label);

    var value = document.createElement("span");
    value.className = "select-value";
    value.textContent = current.label;
    trigger.appendChild(value);

    var hint = document.createElement("span");
    hint.className = "select-hint";
    hint.textContent = current.hint;
    trigger.appendChild(hint);

    var chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "\\u25BE";
    trigger.appendChild(chevron);

    var menu = document.createElement("div");
    menu.className = "select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Output format");

    var optionEls = [];
    OUTPUT_OPTIONS.forEach(function (opt) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "select-option";
      item.tabIndex = -1;
      item.setAttribute("role", "option");
      item.setAttribute("data-value", opt.value);
      item.setAttribute("aria-selected", opt.value === current.value ? "true" : "false");

      var check = document.createElement("span");
      check.className = "select-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "\\u2713";
      item.appendChild(check);

      var label = document.createElement("span");
      label.className = "select-value";
      label.textContent = opt.label;
      item.appendChild(label);

      var optHint = document.createElement("span");
      optHint.className = "select-hint";
      optHint.textContent = opt.hint;
      item.appendChild(optHint);

      item.onclick = function () { chooseOutputFormat(opt.value); };
      menu.appendChild(item);
      optionEls.push(item);
    });

    function focusOptionAt(index) {
      var target = optionEls[(index + optionEls.length) % optionEls.length];
      if (target) target.focus();
    }

    function currentIndex() {
      for (var i = 0; i < OUTPUT_OPTIONS.length; i++) {
        if (OUTPUT_OPTIONS[i].value === current.value) return i;
      }
      return 0;
    }

    trigger.onclick = function () { setOutputMenuOpen(!state.outputMenuOpen); };
    trigger.onkeydown = function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setOutputMenuOpen(true);
        focusOptionAt(currentIndex());
      } else if (e.key === "Escape" && state.outputMenuOpen) {
        e.preventDefault();
        e.stopPropagation();
        setOutputMenuOpen(false);
      }
    };
    menu.onkeydown = function (e) {
      var i = optionEls.indexOf(e.target);
      if (e.key === "ArrowDown") focusOptionAt(i + 1);
      else if (e.key === "ArrowUp") focusOptionAt(i - 1);
      else if (e.key === "Home") focusOptionAt(0);
      else if (e.key === "End") focusOptionAt(optionEls.length - 1);
      else if (e.key === "Escape") { setOutputMenuOpen(false); trigger.focus(); }
      else if (e.key === "Tab") { setOutputMenuOpen(false); return; }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    return wrap;
  }

  // Close the option list on any press outside it (in place — see
  // setOutputMenuOpen for why this never re-renders the panel).
  document.addEventListener(
    "pointerdown",
    function (e) {
      if (!state.outputMenuOpen || !outputSelectEl) return;
      var path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.indexOf(outputSelectEl) !== -1) return;
      setOutputMenuOpen(false);
    },
    true
  );

  function renderPanel() {
    panel.innerHTML = "";
    outputSelectEl = null;
    panel.classList.toggle("minimized", state.minimized);

    var active = state.selections.filter(function (s) { return s.status !== "removed"; });

    var header = document.createElement("div");
    header.className = "row header";

    var grip = document.createElement("span");
    grip.className = "grip";
    grip.title = "Drag to move";
    grip.textContent = "\\u22EE\\u22EE";
    grip.addEventListener("pointerdown", beginDrag);
    header.appendChild(grip);

    var title = document.createElement("span");
    title.className = "title";
    title.textContent = "ReactFig \\u2014 " + active.length + " selection" + (active.length === 1 ? "" : "s");
    header.appendChild(title);

    var spacer = document.createElement("span");
    spacer.className = "spacer";
    header.appendChild(spacer);

    var minimizeBtn = document.createElement("button");
    minimizeBtn.className = "btn icon";
    minimizeBtn.title = state.minimized ? "Expand" : "Minimize";
    minimizeBtn.textContent = state.minimized ? "\\u25A2" : "\\u2013";
    minimizeBtn.onclick = function () {
      state.minimized = !state.minimized;
      state.outputMenuOpen = false;
      renderPanel();
    };
    if (state.minimized) {
      // Keeps the chosen output format visible even while collapsed.
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.title = "Output format: " + currentOutputOption().label;
      chip.textContent = currentOutputOption().label;
      header.appendChild(chip);
    }
    header.appendChild(minimizeBtn);

    if (!state.minimized) {
      var toggle = document.createElement("button");
      toggle.className = "btn" + (state.active ? " active" : "");
      toggle.textContent = state.active ? "Selecting\\u2026" : "Select";
      toggle.onclick = function () { setActive(!state.active); };
      header.appendChild(toggle);
    }

    panel.appendChild(header);
    applyPanelPosition();

    if (state.minimized) {
      if (state.pending) positionPreviewNextToPanel();
      return;
    }

    var body = document.createElement("div");
    body.className = "body";

    var settings = document.createElement("div");
    settings.className = "settings";
    var settingsLabel = document.createElement("span");
    settingsLabel.className = "field-label";
    settingsLabel.textContent = "Output format";
    settings.appendChild(settingsLabel);
    settings.appendChild(buildOutputSelect());
    body.appendChild(settings);

    var hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = active.length > 0
      ? "Click Done / Continue below when you're finished selecting \\u2014 or finalize from your MCP client instead, either works."
      : "Select at least one element, then click Done / Continue when you're finished.";
    body.appendChild(hint);

    if (active.length > 0) {
      var doneRow = document.createElement("div");
      doneRow.className = "row";
      var doneBtn = document.createElement("button");
      doneBtn.className = "btn primary";
      doneBtn.textContent = state.markingDone ? "Finishing\\u2026" : "Done / Continue";
      doneBtn.disabled = Boolean(state.markingDone);
      doneBtn.onclick = function () {
        if (state.markingDone) return;
        state.markingDone = true;
        renderPanel();
        window.__reactfigMarkDone().catch(function (err) {
          console.error("[reactfig] mark-done failed:", err);
          state.markingDone = false;
          renderPanel();
        });
        // No success re-render here on purpose: a successful call closes
        // the browser (InteractiveBrowserOptions.closeOnDone, default
        // true) shortly after — nothing left to update in this page.
      };
      doneRow.appendChild(doneBtn);
      body.appendChild(doneRow);
    }

    if (state.selections.length > 0) {
      var log = document.createElement("div");
      log.className = "log";
      state.selections.forEach(function (s) {
        var entry = document.createElement("div");
        entry.className = "entry" + (s.status === "removed" ? " removed" : "");
        var name = document.createElement("span");
        name.className = "name";
        var label = s.componentPath && s.componentPath.length ? s.componentPath[s.componentPath.length - 1] : "(unnamed element)";
        name.textContent = s.order + ". " + label;
        entry.appendChild(name);
        if (s.status !== "removed") {
          var removeBtn = document.createElement("button");
          removeBtn.className = "btn danger";
          removeBtn.textContent = "\\u2715";
          removeBtn.onclick = function () {
            window.__reactfigRemoveSelection(s.selectionId).catch(function () {});
          };
          entry.appendChild(removeBtn);
        }
        log.appendChild(entry);
      });
      body.appendChild(log);
    }

    panel.appendChild(body);
    if (focusOutputTriggerAfterRender) {
      focusOutputTriggerAfterRender = false;
      var selectTrigger = outputSelectEl && outputSelectEl.querySelector(".select-trigger");
      if (selectTrigger) selectTrigger.focus();
    }
    if (state.pending) positionPreviewNextToPanel();
  }

  function renderPreview() {
    if (!state.pending) {
      previewBox.style.display = "none";
      return;
    }
    previewBox.style.display = "block";
    previewBox.innerHTML = "";
    var label = document.createElement("div");
    var name = state.pending.componentPath && state.pending.componentPath.length
      ? state.pending.componentPath[state.pending.componentPath.length - 1]
      : state.pending.tag;
    label.innerHTML = "<strong>" + name + "</strong>";
    previewBox.appendChild(label);

    var sel = document.createElement("div");
    sel.className = "dim";
    sel.textContent = state.pending.selector;
    previewBox.appendChild(sel);

    // Read-only echo of the format chosen in the panel's settings area
    // (see buildOutputSelect). The control itself lives there so it is
    // always visible, not only while a selection is being previewed.
    var outputRow = document.createElement("div");
    outputRow.className = "dim";
    outputRow.style.marginTop = "6px";
    outputRow.textContent = "Output: " + currentOutputOption().label;
    previewBox.appendChild(outputRow);

    var actions = document.createElement("div");
    actions.className = "actions";

    function actionButton(text, handler) {
      var b = document.createElement("button");
      b.className = "btn";
      b.textContent = text;
      b.onclick = handler;
      return b;
    }

    actions.appendChild(actionButton("Confirm", confirmPending));
    actions.appendChild(actionButton("\\u2191 Parent", function () { adjustPending("parent"); }));
    actions.appendChild(actionButton("\\u2193 Child", function () { adjustPending("child"); }));
    actions.appendChild(actionButton("Cancel", function () { setPending(null); }));
    previewBox.appendChild(actions);

    // Sizing/content is fully in the DOM now — safe to measure and
    // position against the panel's actual current rect.
    positionPreviewNextToPanel();
  }

  function setPending(boundary) {
    state.pending = boundary;
    if (boundary) {
      var el = document.querySelector(boundary.selector);
      if (el) renderRect(el, highlightBox);
    } else {
      highlightBox.style.display = "none";
    }
    renderPreview();
  }

  function adjustPending(direction) {
    if (!state.pending) return;
    var next = resolveComponentBoundary({ selector: state.pending.selector, direction: direction });
    if (next) setPending(next);
  }

  function confirmPending() {
    if (!state.pending) return;
    var boundary = state.pending;
    window.__reactfigConfirmSelection({
      url: location.href,
      pageTitle: document.title,
      selector: boundary.selector,
      componentPath: boundary.componentPath,
      tag: boundary.tag,
      rect: boundary.rect,
      outputFormat: state.pendingOutputFormat
    }).catch(function (err) {
      console.error("[reactfig] selection capture failed:", err);
    });
    setPending(null);
  }

  function setActive(active) {
    state.active = active;
    if (!active) setPending(null);
    renderPanel();
  }

  document.addEventListener(
    "mousemove",
    function (e) {
      if (!state.active || state.pending) return;
      var target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || host.contains(target)) {
        highlightBox.style.display = "none";
        return;
      }
      renderRect(target, highlightBox);
    },
    true
  );

  document.addEventListener(
    "click",
    function (e) {
      if (!state.active || state.pending) return;
      var target = e.target;
      if (!target || host.contains(target)) return;
      e.preventDefault();
      e.stopPropagation();
      target.setAttribute(MARKER_ATTR, "1");
      var boundary = resolveComponentBoundary({ selector: "[" + MARKER_ATTR + '="1"]', direction: "root" });
      target.removeAttribute(MARKER_ATTR);
      if (boundary) setPending(boundary);
    },
    true
  );

  // Node -> browser: called after every confirm/remove so the panel
  // reflects the durable, persisted state rather than optimistic local
  // state that could drift from what's actually on disk.
  window.__reactfigApplyState = function (summary) {
    state.selections = summary && summary.selections ? summary.selections : [];
    renderPanel();
  };

  // Node -> browser: hides/shows the ENTIRE overlay (panel, preview,
  // highlight box — everything lives under this one host) around the
  // screenshot Playwright takes of the confirmed target element
  // (collectionBrowser.ts). The overlay is a real, painted, on-top
  // element, so for a large/full-viewport target (e.g. capturing a
  // whole dashboard) it can otherwise end up baked into the captured
  // screenshot's pixels. Setting visibility:hidden (not removing the
  // host, not display:none) keeps layout/state untouched and is
  // restored immediately after — the hidden window is only as long as
  // the one screenshot call takes.
  window.__reactfigSetOverlayVisible = function (visible) {
    host.style.visibility = visible ? "" : "hidden";
  };

  // SPA navigations (history.pushState/replaceState) don't reload the
  // page, so this init script only runs once per real navigation — but
  // some app frameworks re-render document.documentElement's subtree in
  // ways that could detach our host node, and a top-layer popover can
  // also get force-closed by certain browser/page interactions (e.g. the
  // Esc key, in some configurations). Cheaply re-attach/re-show on the
  // next tick if that ever happens, rather than assuming one initial
  // attach is permanent.
  setInterval(attachHost, 1000);

  renderPanel();

  // One-time, clearly-labeled diagnostic — this is a dev-time tool, not
  // shipped product code, so a single console.log here is appropriate:
  // if the overlay still doesn't render on some app, this gives an
  // actual data point (attached? popover promoted? real on-screen rect?)
  // instead of another blind guess.
  setTimeout(function () {
    var hostRect = host.getBoundingClientRect();
    var panelRect = panel.getBoundingClientRect();
    var hostStyle = window.getComputedStyle(host);
    console.log("[reactfig] overlay diagnostic", {
      overlayVersion: OVERLAY_VERSION,
      attached: document.documentElement.contains(host),
      popoverSupported: supportsPopover,
      popoverOpen: supportsPopover && typeof host.matches === "function" ? host.matches(":popover-open") : null,
      hostRect: { top: hostRect.top, left: hostRect.left, width: hostRect.width, height: hostRect.height },
      panelRect: { top: panelRect.top, left: panelRect.left, width: panelRect.width, height: panelRect.height },
      hostComputedDisplay: hostStyle.display,
      hostComputedPosition: hostStyle.position,
      hostComputedZIndex: hostStyle.zIndex
    });
  }, 500);
})();
`;
}