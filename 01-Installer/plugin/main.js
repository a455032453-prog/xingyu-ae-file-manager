(function () {
  "use strict";

  window.addEventListener("error", function (event) {
    showFatalError(event.message || "Unknown error");
  });

  window.addEventListener("unhandledrejection", function (event) {
    showFatalError(event.reason && event.reason.message ? event.reason.message : String(event.reason || "Unhandled promise rejection"));
  });

  if (typeof window.require !== "function" || typeof window.CSInterface !== "function") return;

  var nodeRequire = window.require;
  var fs = nodeRequire("fs");
  var path = nodeRequire("path");
  var os = nodeRequire("os");
  var childProcess = nodeRequire("child_process");
  var cs = new window.CSInterface();
  var platform = os.platform();

  var configDir = getConfigDir();
  var configPath = path.join(configDir, "settings.json");

  var imageExts = new Set([".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".gif", ".webp", ".exr", ".dpx"]);
  var videoExts = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mpg", ".mpeg"]);
  var audioExts = new Set([".wav", ".mp3", ".aiff", ".aif", ".m4a", ".aac"]);
  var designExts = new Set([".psd", ".ai", ".eps", ".pdf"]);
  var projectExts = new Set([".aep", ".aet"]);
  var aeImportExts = new Set(Array.from(imageExts).concat(Array.from(videoExts), Array.from(audioExts), Array.from(designExts), Array.from(projectExts)));
  var sequenceExts = new Set([".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".exr", ".dpx"]);
  var shortcutExts = new Set([".lnk"]);

  var state = {
    cwd: resolveStartPath(),
    entries: [],
    selected: new Set(),
    lastSelected: null,
    view: "grid",
    clipboard: null,
    search: "",
    history: [],
    navigatingHistory: false,
    settings: loadSettings(),
    marquee: null,
    showImportableOnly: true,
    thumbSize: 132,
    collectProjectBusy: false,
  };

  var els = {
    clipState: document.getElementById("clipState"),
    pathInput: document.getElementById("pathInput"),
    pastePathBtn: document.getElementById("pastePathBtn"),
    openPathBtn: document.getElementById("openPathBtn"),
    historyBackBtn: document.getElementById("historyBackBtn"),
    backBtn: document.getElementById("backBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    revealBtn: document.getElementById("revealBtn"),
    searchInput: document.getElementById("searchInput"),
    gridViewBtn: document.getElementById("gridViewBtn"),
    listViewBtn: document.getElementById("listViewBtn"),
    importFilterToggle: document.getElementById("importFilterToggle"),
    thumbSizeSlider: document.getElementById("thumbSizeSlider"),
    thumbSizeValue: document.getElementById("thumbSizeValue"),
    copyBtn: document.getElementById("copyBtn"),
    cutBtn: document.getElementById("cutBtn"),
    pasteBtn: document.getElementById("pasteBtn"),
    newFolderBtn: document.getElementById("newFolderBtn"),
    fileGrid: document.getElementById("fileGrid"),
    filePane: document.querySelector(".file-pane"),
    selectionMarquee: document.getElementById("selectionMarquee"),
    folderSummary: document.getElementById("folderSummary"),
    selectionSummary: document.getElementById("selectionSummary"),
    preview: document.getElementById("preview"),
    metaPanel: document.getElementById("metaPanel"),
    previewPanel: document.querySelector(".preview-panel"),
    contentArea: document.querySelector(".content-area"),
    openFileBtn: document.getElementById("openFileBtn"),
    previewImportBtn: document.getElementById("previewImportBtn"),
    previewLayerBtn: document.getElementById("previewLayerBtn"),
    filePreviewOverlay: document.getElementById("filePreviewOverlay"),
    filePreviewOverlayContent: document.getElementById("filePreviewOverlayContent"),
    closeFilePreviewBtn: document.getElementById("closeFilePreviewBtn"),
    importBtn: document.getElementById("importBtn"),
    importLayerBtn: document.getElementById("importLayerBtn"),
    replaceLayerBtn: document.getElementById("replaceLayerBtn"),
    importCompBtn: document.getElementById("importCompBtn"),
    captureFrameBtn: document.getElementById("captureFrameBtn"),
    locateAeItemBtn: document.getElementById("locateAeItemBtn"),
    organizeAssetsBtn: document.getElementById("organizeAssetsBtn"),
    duplicateCompBtn: document.getElementById("duplicateCompBtn"),
    exportCompBtn: document.getElementById("exportCompBtn"),
    collectCompBtn: document.getElementById("collectCompBtn"),
    collectProjectBtn: document.getElementById("collectProjectBtn"),
    importCount: document.getElementById("importCount"),
    sequenceToggle: document.getElementById("sequenceToggle"),
    recentPaths: document.getElementById("recentPaths"),
    clearRecentBtn: document.getElementById("clearRecentBtn"),
    toast: document.getElementById("toast"),
    contextMenu: document.getElementById("contextMenu")
  };

  function init() {
    state.showImportableOnly = state.settings.showImportableOnly !== false;
    state.thumbSize = clampThumbSize(state.settings.thumbSize || 132);
    bindEvents();
    syncFilterControls();
    applyThumbSize();
    renderPathLists();
    openPath(state.cwd);
  }

  function bindEvents() {
    els.openPathBtn.addEventListener("click", openPathFromInput);
    els.pastePathBtn.addEventListener("click", pastePathFromClipboard);
    els.pathInput.addEventListener("click", function () { els.pathInput.select(); });
    els.pathInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") openPathFromInput();
    });
    els.historyBackBtn.addEventListener("click", goHistoryBack);
    els.backBtn.addEventListener("click", function () { openPath(path.dirname(state.cwd)); });
    els.refreshBtn.addEventListener("click", function () { openPath(state.cwd, { keepSelection: true }); });
    els.revealBtn.addEventListener("click", function () { revealPath(state.cwd); });
    els.searchInput.addEventListener("input", function () {
      state.search = els.searchInput.value.trim().toLowerCase();
      renderFiles();
    });
    els.gridViewBtn.addEventListener("click", function () { setView("grid"); });
    els.listViewBtn.addEventListener("click", function () { setView("list"); });
    els.importFilterToggle.addEventListener("change", function () {
      state.showImportableOnly = !!els.importFilterToggle.checked;
      state.settings.showImportableOnly = state.showImportableOnly;
      saveSettings();
      state.selected = new Set(Array.from(state.selected).filter(function (item) {
        return getFilteredEntries().some(function (entry) { return entry.path === item; });
      }));
      renderFiles();
      renderPreview();
    });
    els.fileGrid.addEventListener("scroll", scheduleThumbnailLoading);
    els.thumbSizeSlider.addEventListener("input", function () {
      setThumbSize(Number(els.thumbSizeSlider.value), false);
    });
    els.thumbSizeSlider.addEventListener("change", function () {
      setThumbSize(Number(els.thumbSizeSlider.value), true);
    });
    els.copyBtn.addEventListener("click", function () { setClipboard("copy"); });
    els.cutBtn.addEventListener("click", function () { setClipboard("move"); });
    els.pasteBtn.addEventListener("click", pasteClipboard);
    els.newFolderBtn.addEventListener("click", createFolder);
    bindClick(els.importBtn, function () { importSelectedToAe("footage"); });
    bindClick(document.getElementById("sendToFreeImageBtn"), sendSelectionToFreeImage);
    bindClick(els.importLayerBtn, function () { importSelectedToAe("layer"); });
    bindClick(els.replaceLayerBtn, replaceSelectedLayersWithSelection);
    bindClick(els.importCompBtn, function () { importSelectedToAe("comp"); });
    bindClick(els.captureFrameBtn, captureCurrentFrame);
    bindClick(els.locateAeItemBtn, locateSelectedAeItemPath);
    bindClick(els.organizeAssetsBtn, organizeProjectAssetsToCurrentFolder);
    bindClick(els.duplicateCompBtn, duplicateSelectedComp);
    bindClick(els.exportCompBtn, exportActiveCompToCurrentFolder);
    bindClick(els.collectCompBtn, collectSelectedCompToCurrentFolder);
    bindClick(els.collectProjectBtn, collectProjectToCurrentFolder);
    els.clearRecentBtn.addEventListener("click", clearRecentPaths);
    els.openFileBtn.addEventListener("click", function () {
      var target = getPrimarySelectionPath();
      if (target) openExternal(target);
    });
    bindClick(els.previewImportBtn, function () { importSelectedToAe("footage"); });
    bindClick(els.previewLayerBtn, function () { importSelectedToAe("layer"); });
    bindClick(els.closeFilePreviewBtn, closeFilePreview);
    bindClick(els.filePreviewOverlay, function (event) {
      if (event.target === els.filePreviewOverlay) closeFilePreview();
    });


    document.addEventListener("keydown", handleShortcuts);
    document.addEventListener("click", function (event) {
      if (els.contextMenu && !els.contextMenu.hidden && !els.contextMenu.contains(event.target)) hideContextMenu();
    });
    els.fileGrid.addEventListener("contextmenu", function (event) {
      if (event.target.closest && event.target.closest(".file-card")) return;
      event.preventDefault();
      showFileGridContextMenu(event.clientX, event.clientY);
    });

    bindExternalDrop();
    bindMarqueeSelection();
    bindDropImportButton();
    bindThumbWheel();
  }

  function bindClick(element, handler) {
    if (!element) return;
    element.addEventListener("click", handler);
  }

  function bindExternalDrop() {
    ["dragenter", "dragover"].forEach(function (eventName) {
      els.filePane.addEventListener(eventName, function (event) {
        event.preventDefault();
        els.filePane.classList.add("dragging");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      els.filePane.addEventListener(eventName, function () {
        els.filePane.classList.remove("dragging");
      });
    });
    els.filePane.addEventListener("drop", function (event) {
      event.preventDefault();
      copyDroppedIntoCurrentFolder(getExternalFilePaths(event));
    });
  }

  function getExternalFilePaths(event) {
    var paths = Array.prototype.slice.call(event.dataTransfer.files || [])
      .map(function (file) { return file.path; })
      .filter(Boolean);
    if (paths.length) return uniqueFiles(paths);
    var uriList = "";
    var text = "";
    try {
      uriList = event.dataTransfer.getData("text/uri-list") || "";
      text = event.dataTransfer.getData("text/plain") || "";
    } catch (err) {}
    return uniqueFiles(uriList.split(/\r?\n/).concat(text.split(/\r?\n/))
      .map(normalizeLoosePath)
      .filter(function (item) { return item && exists(item); }));
  }

  function copyDroppedIntoCurrentFolder(paths) {
    var copied = 0;
    paths.forEach(function (source) {
      if (!exists(source) || isDirectory(source)) return;
      try {
        fs.copyFileSync(source, uniqueDestination(path.join(state.cwd, path.basename(source))));
        copied += 1;
      } catch (err) {
        toast("拖拽文件复制失败：" + err.message);
      }
    });
    if (copied) {
      loadDirectory({ keepSelection: true });
      toast("已将 " + copied + " 个文件放入当前目录");
    }
  }

  function bindDropImportButton() {
    [
      { button: els.importBtn, mode: "footage" },
      { button: els.importLayerBtn, mode: "layer" },
      { button: els.replaceLayerBtn, mode: "replace" },
      { button: els.importCompBtn, mode: "comp" }
    ].filter(function (target) { return !!target.button; }).forEach(function (target) {
      ["dragenter", "dragover"].forEach(function (eventName) {
        target.button.addEventListener(eventName, function (event) {
          event.preventDefault();
          target.button.classList.add("drop-ready");
        });
      });
      ["dragleave", "drop"].forEach(function (eventName) {
        target.button.addEventListener(eventName, function () {
          target.button.classList.remove("drop-ready");
        });
      });
      target.button.addEventListener("drop", function (event) {
        event.preventDefault();
        importDroppedToAe(event, target.mode);
      });
    });
  }

  function importDroppedToAe(event, mode) {
    var droppedPaths = getDroppedPaths(event);
    if (mode === "replace") {
      if (droppedPaths.length) replaceLayersWithPaths(droppedPaths);
      else replaceSelectedLayersWithSelection();
      return;
    }
    if (droppedPaths.length) {
      importPathsToAe(droppedPaths, mode);
      return;
    }
    importSelectedToAe(mode);
  }

  function getDroppedPaths(event) {
    var files = Array.prototype.slice.call(event.dataTransfer.files || [])
      .map(function (file) { return file.path; })
      .filter(Boolean);
    if (files.length) return files;

    var text = "";
    var uriList = "";
    var downloadUrl = "";
    var fileList = "";
    try {
      text = event.dataTransfer.getData("text/plain") || "";
      uriList = event.dataTransfer.getData("text/uri-list") || "";
      downloadUrl = event.dataTransfer.getData("DownloadURL") || "";
      fileList = event.dataTransfer.getData("application/x-file-list") || "";
    } catch (err) {
      text = "";
    }
    var downloadPath = downloadUrl.split(":").slice(2).join(":");
    return text.split(/\r?\n/).concat(uriList.split(/\r?\n/)).concat(fileList.split(/\r?\n/)).concat(downloadPath)
      .map(function (item) { return normalizeLoosePath(item); })
      .filter(function (item) { return item && exists(item); });
  }

  function bindThumbWheel() {
    els.fileGrid.addEventListener("wheel", function (event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (state.view !== "grid") return;
      event.preventDefault();
      var next = state.thumbSize + (event.deltaY < 0 ? 8 : -8);
      setThumbSize(next, true);
    });
  }

  function bindMarqueeSelection() {
    els.fileGrid.addEventListener("mousedown", function (event) {
      if (event.button !== 0 || event.detail > 1 || event.target.closest(".file-card")) return;
      var gridRect = els.fileGrid.getBoundingClientRect();
      state.marquee = {
        startX: event.clientX,
        startY: event.clientY,
        additive: event.ctrlKey || event.metaKey,
        base: new Set(state.selected),
        active: false,
        gridLeft: gridRect.left,
        gridTop: gridRect.top,
        scrollLeft: els.fileGrid.scrollLeft,
        scrollTop: els.fileGrid.scrollTop
      };
      document.addEventListener("mousemove", updateMarqueeSelection);
      document.addEventListener("mouseup", finishMarqueeSelection, { once: true });
    });
  }

  function updateMarqueeSelection(event) {
    if (!state.marquee) return;
    var m = state.marquee;
    if (!m.active && Math.abs(event.clientX - m.startX) + Math.abs(event.clientY - m.startY) < 6) return;
    m.active = true;

    var left = Math.min(m.startX, event.clientX);
    var top = Math.min(m.startY, event.clientY);
    var right = Math.max(m.startX, event.clientX);
    var bottom = Math.max(m.startY, event.clientY);
    var paneRect = els.filePane.getBoundingClientRect();

    els.selectionMarquee.hidden = false;
    els.selectionMarquee.style.left = (left - paneRect.left) + "px";
    els.selectionMarquee.style.top = (top - paneRect.top) + "px";
    els.selectionMarquee.style.width = Math.max(1, right - left) + "px";
    els.selectionMarquee.style.height = Math.max(1, bottom - top) + "px";

    var next = m.additive ? new Set(m.base) : new Set();
    Array.prototype.forEach.call(els.fileGrid.querySelectorAll(".file-card"), function (card) {
      var rect = card.getBoundingClientRect();
      if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) {
        next.add(card.getAttribute("data-path"));
      }
    });
    state.selected = next;
    updateSelectionClasses();
    updateActionState();
  }

  function finishMarqueeSelection() {
    document.removeEventListener("mousemove", updateMarqueeSelection);
    if (state.marquee && state.marquee.active) {
      var selected = getSelectedPaths();
      state.lastSelected = selected.length ? selected[selected.length - 1] : state.lastSelected;
      renderPreview();
    }
    state.marquee = null;
    els.selectionMarquee.hidden = true;
  }

  function handleShortcuts(event) {
    var ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;
    var key = event.key.toLowerCase();
    if (key === "c") {
      setClipboard("copy");
      event.preventDefault();
    } else if (key === "x") {
      setClipboard("move");
      event.preventDefault();
    } else if (key === "v") {
      pasteClipboard();
      event.preventDefault();
    } else if (key === "a") {
      selectAll();
      event.preventDefault();
    } else if (key === "i") {
      importSelectedToAe("footage");
      event.preventDefault();
    }
  }

  function openPathFromInput() {
    var raw = els.pathInput.value.trim().replace(/^["']|["']$/g, "");
    if (raw) openPath(raw);
  }

  function pastePathFromClipboard() {
    readClipboardText(function (text) {
      var value = String(text || "").trim().replace(/^["']|["']$/g, "");
      if (!value) {
        toast("剪贴板没有可用路径");
        return;
      }
      els.pathInput.value = value;
      openPath(value);
    });
  }

  function readClipboardText(callback) {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(callback).catch(function () {
        readClipboardTextByProcess(callback);
      });
      return;
    }
    readClipboardTextByProcess(callback);
  }

  function readClipboardTextByProcess(callback) {
    var command;
    var args;
    if (platform === "win32") {
      command = "powershell.exe";
      args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw"
      ];
    } else if (platform === "darwin") {
      command = "pbpaste";
      args = [];
    } else {
      command = "xclip";
      args = ["-selection", "clipboard", "-o"];
    }
    childProcess.execFile(command, args, { windowsHide: true, encoding: "utf8", timeout: 3000 }, function (err, stdout) {
      callback(err ? "" : normalizeClipboardText(stdout));
    });
  }

  function writeFileClipboard(paths, callback) {
    if (platform !== "win32") {
      callback(false);
      return;
    }

    var env = Object.assign({}, process.env, {
      AFM_FILE_CLIPBOARD_JSON: JSON.stringify(paths)
    });
    var args = [
      "-Sta",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $parsed=ConvertFrom-Json -InputObject $env:AFM_FILE_CLIPBOARD_JSON; $paths=@(); if ($parsed -is [System.Array]) { for($i=0; $i -lt $parsed.Count; $i += 1) { $paths += [string]$parsed[$i] } } else { $paths=@([string]$parsed) }; if ($paths.Count -lt 1) { throw 'empty file clipboard' }; $list=New-Object System.Collections.Specialized.StringCollection; for($i=0; $i -lt $paths.Count; $i += 1) { [void]$list.Add([string]$paths[$i]) }; [System.Windows.Forms.Clipboard]::SetFileDropList($list)"
    ];

    childProcess.execFile("powershell.exe", args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      env: env
    }, function (err) {
      callback(!err);
    });
  }

  function readClipboardFiles(callback) {
    if (platform !== "win32") {
      callback([]);
      return;
    }

    var args = [
      "-Sta",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { $list=[System.Windows.Forms.Clipboard]::GetFileDropList(); for($i=0; $i -lt $list.Count; $i += 1) { [Console]::WriteLine([string]$list[$i]) } }"
    ];
    childProcess.execFile("powershell.exe", args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000
    }, function (err, stdout) {
      if (err) {
        callback([]);
        return;
      }
      callback(uniqueFiles(String(stdout || "").split(/\r?\n/)
        .map(normalizeLoosePath)
        .filter(function (item) { return item && exists(item); })));
    });
  }

  function normalizeClipboardText(text) {
    return String(text || "").replace(/^\uFEFF/, "").trim();
  }

  function openPath(target, options) {
    options = options || {};
    target = normalizeLoosePath(target);

    if (!exists(target)) {
      toast("路径不存在，或当前账户无权访问");
      return;
    }

    var stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      toast("无法访问该路径");
      return;
    }

    var nextCwd = stat.isFile() ? path.dirname(target) : target;
    rememberHistory(nextCwd);

    state.cwd = nextCwd;
    state.settings.lastFolder = nextCwd;
    saveSettings();
    addRecentPath(nextCwd);
    loadDirectory(options);
    if (stat.isFile()) selectOnly(target);
  }

  function rememberHistory(nextCwd) {
    if (state.navigatingHistory) return;
    if (!state.cwd || path.normalize(state.cwd) === path.normalize(nextCwd)) return;
    state.history.push(state.cwd);
    if (state.history.length > 60) state.history.shift();
  }

  function goHistoryBack() {
    if (!state.history.length) {
      toast("没有上一次访问路径");
      return;
    }
    var target = state.history.pop();
    state.navigatingHistory = true;
    openPath(target);
    state.navigatingHistory = false;
  }

  function loadDirectory(options) {
    options = options || {};
    state.selected = options.keepSelection ? new Set(state.selected) : new Set();
    state.entries = [];

    try {
      state.entries = fs.readdirSync(state.cwd).map(function (name) {
        var fullPath = path.join(state.cwd, name);
        var stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
          return null;
        }

        var isDir = stat.isDirectory();
        var ext = path.extname(name).toLowerCase();
        var isShortcut = !isDir && platform === "win32" && shortcutExts.has(ext);

        return {
          name: name,
          path: fullPath,
          openPath: fullPath,
          isDir: isDir,
          isShortcut: isShortcut,
          shortcutTarget: null,
          ext: ext,
          size: stat.size,
          mtime: stat.mtime
        };
      }).filter(Boolean).sort(sortEntries);
    } catch (err2) {
      toast("无法读取文件夹：" + err2.message);
      return;
    }

    state.selected = new Set(Array.from(state.selected).filter(function (item) {
      return state.entries.some(function (entry) { return entry.path === item; });
    }));
    els.pathInput.value = state.cwd;
    renderFiles();
    renderPreview();
  }

  function sortEntries(a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (a.isShortcut !== b.isShortcut) return a.isShortcut ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  }

  function renderFiles() {
    var entries = getFilteredEntries();
    els.fileGrid.className = "file-grid " + state.view;
    els.folderSummary.textContent = state.cwd + (state.showImportableOnly ? " · 只显示 AE 可导入文件" : " · 显示全部文件");

    if (!entries.length) {
      els.fileGrid.innerHTML = '<div class="empty-state">' + (state.showImportableOnly ? '当前文件夹没有可导入 AE 的素材。<br>关闭“只看 AE 素材”可查看全部文件。' : '当前文件夹没有可显示的内容。') + '</div>';
      updateActionState();
      return;
    }

    els.fileGrid.innerHTML = entries.map(function (entry) {
      var selected = state.selected.has(entry.path) ? " selected" : "";
      var importableClass = isImportableEntry(entry) ? " importable" : "";
      var size = entry.isShortcut ? "快捷方式" : (entry.isDir ? "文件夹" : (aeImportExts.has(entry.ext) ? formatBytes(entry.size) : "不可导入"));
      return [
        '<div class="file-card' + selected + importableClass + '" data-path="' + escapeAttr(entry.path) + '" title="' + escapeAttr(entry.name) + '" draggable="true">',
        '<div class="file-icon">' + getThumbnailHtml(entry) + '</div>',
        '<div class="file-name">' + escapeHtml(entry.name) + '</div>',
        '<div class="file-sub">' + escapeHtml(size) + '</div>',
        '<div class="file-sub">' + escapeHtml(formatDate(entry.mtime)) + '</div>',
        '</div>'
      ].join("");
    }).join("");

    Array.prototype.forEach.call(els.fileGrid.querySelectorAll(".file-card"), function (card) {
      card.addEventListener("click", function (event) {
        handleSelect(card.getAttribute("data-path"), event);
      });
      card.addEventListener("dblclick", function () {
        var entry = findEntry(card.getAttribute("data-path"));
        if (entry && entry.isShortcut) openShortcut(entry);
        else if (entry && entry.isDir) openPath(entry.openPath || entry.path);
        else if (entry) openExternal(entry.path);
      });
      card.addEventListener("dragstart", function (event) {
        var targetPath = card.getAttribute("data-path");
        if (!state.selected.has(targetPath)) handleSelect(targetPath, { ctrlKey: false, metaKey: false, shiftKey: false });
        var selectedPaths = getSelectedPaths();
        event.dataTransfer.setData("text/plain", selectedPaths.join("\n"));
        event.dataTransfer.setData("text/uri-list", selectedPaths.map(pathToFileUrl).join("\n"));
        event.dataTransfer.setData("application/x-file-list", selectedPaths.join("\n"));
        event.dataTransfer.setData("application/x-moz-file", selectedPaths[0] || "");
        event.dataTransfer.setData("text/html", selectedPaths.map(function (item) {
          return '<a href="' + pathToFileUrl(item) + '">' + escapeHtml(path.basename(item)) + '</a>';
        }).join("\n"));
        if (selectedPaths.length === 1) {
          event.dataTransfer.setData("DownloadURL", "application/octet-stream:" + path.basename(selectedPaths[0]) + ":" + pathToFileUrl(selectedPaths[0]));
        }
        event.dataTransfer.effectAllowed = "copy";
      });
      card.addEventListener("contextmenu", function (event) {
        event.preventDefault();
        var entry = findEntry(card.getAttribute("data-path"));
        if (entry) showContextMenu(entry, event.clientX, event.clientY);
      });
    });

    scheduleThumbnailLoading();
    updateActionState();
  }

  var thumbnailLoadTimer = null;
  var mediaFrameQueue = [];
  var mediaFrameActive = 0;
  var mediaFrameConcurrency = 2;

  function scheduleThumbnailLoading() {
    window.clearTimeout(thumbnailLoadTimer);
    thumbnailLoadTimer = window.setTimeout(loadVisibleThumbnailImages, 40);
  }

  function loadVisibleThumbnailImages() {
    if (!els.fileGrid) return;
    var gridRect = els.fileGrid.getBoundingClientRect();
    Array.prototype.forEach.call(els.fileGrid.querySelectorAll("img[data-src]"), function (media) {
      var rect = media.getBoundingClientRect();
      if (rect.bottom < gridRect.top - 180 || rect.top > gridRect.bottom + 180) return;
      var source = media.getAttribute("data-src");
      if (!source) return;
      media.removeAttribute("data-src");
      media.onload = function () { media.classList.add("thumb-loaded"); };
      media.onerror = function () { media.classList.add("thumb-error"); media.removeAttribute("src"); };
      media.setAttribute("src", source);
    });
    Array.prototype.forEach.call(els.fileGrid.querySelectorAll("canvas[data-media-src]"), function (canvas) {
      var rect = canvas.getBoundingClientRect();
      if (rect.bottom < gridRect.top - 180 || rect.top > gridRect.bottom + 180) return;
      queueMediaFrame(canvas, canvas.getAttribute("data-media-src"), canvas.getAttribute("data-media-kind"));
    });
  }

  function queueMediaFrame(canvas, source, kind) {
    if (!canvas || !source || canvas._mediaFrameQueued) return;
    canvas._mediaFrameQueued = true;
    canvas.classList.add("media-frame-loading");
    mediaFrameQueue.push({ canvas: canvas, source: source, kind: kind });
    pumpMediaFrameQueue();
  }

  function pumpMediaFrameQueue() {
    while (mediaFrameActive < mediaFrameConcurrency && mediaFrameQueue.length) {
      var job = mediaFrameQueue.shift();
      mediaFrameActive += 1;
      captureMediaFirstFrame(job.canvas, job.source, job.kind, function (success) {
        mediaFrameActive -= 1;
        if (success) job.canvas.classList.add("media-frame-loaded");
        else job.canvas.classList.add("media-frame-error");
        job.canvas.classList.remove("media-frame-loading");
        pumpMediaFrameQueue();
      });
    }
  }

  function captureMediaFirstFrame(canvas, source, kind, done) {
    var finished = false;
    function finish(success) {
      if (finished) return;
      finished = true;
      done(!!success);
    }
    function drawFrame(media, width, height) {
      if (!width || !height) return false;
      var maxDimension = 1920;
      var scale = Math.min(1, maxDimension / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      var context = canvas.getContext("2d");
      if (!context) return false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(media, 0, 0, canvas.width, canvas.height);
      return true;
    }
    if (kind === "gif") {
      var image = new Image();
      image.onload = function () {
        var success = false;
        try { success = drawFrame(image, image.naturalWidth, image.naturalHeight); } catch (err) { success = false; }
        image.onload = null;
        image.onerror = null;
        image.src = "";
        finish(success);
      };
      image.onerror = function () { image.onload = null; image.onerror = null; image.src = ""; finish(false); };
      image.src = source;
      return;
    }
    var video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onloadeddata = function () {
      var success = false;
      try { success = drawFrame(video, video.videoWidth, video.videoHeight); } catch (err) { success = false; }
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      finish(success);
    };
    video.onerror = function () {
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute("src");
      finish(false);
    };
    video.src = source;
    video.load();
  }

  function getFilteredEntries() {
    var entries = state.entries.filter(function (entry) {
      if (!state.showImportableOnly) return true;
      return entry.isDir || entry.isShortcut || aeImportExts.has(entry.ext);
    });
    if (!state.search) return entries;
    return entries.filter(function (entry) {
      return entry.name.toLowerCase().indexOf(state.search) !== -1;
    });
  }

  function isImportableEntry(entry) {
    return entry && !entry.isDir && !entry.isShortcut && aeImportExts.has(entry.ext);
  }

  function handleSelect(targetPath, event) {
    var visible = getFilteredEntries().map(function (entry) { return entry.path; });

    if (event.shiftKey && state.lastSelected) {
      var start = visible.indexOf(state.lastSelected);
      var end = visible.indexOf(targetPath);
      if (start !== -1 && end !== -1) {
        state.selected.clear();
        visible.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(function (item) {
          state.selected.add(item);
        });
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (state.selected.has(targetPath)) state.selected.delete(targetPath);
      else state.selected.add(targetPath);
      state.lastSelected = targetPath;
    } else {
      state.selected.clear();
      state.selected.add(targetPath);
      state.lastSelected = targetPath;
    }

    updateSelectionClasses();
    renderPreview();
    updateActionState();
  }

  function selectOnly(targetPath) {
    state.selected.clear();
    if (findEntry(targetPath)) {
      state.selected.add(targetPath);
      state.lastSelected = targetPath;
    }
    updateSelectionClasses();
    renderPreview();
    updateActionState();
  }

  function updateSelectionClasses() {
    Array.prototype.forEach.call(els.fileGrid.querySelectorAll(".file-card"), function (card) {
      card.classList.toggle("selected", state.selected.has(card.getAttribute("data-path")));
    });
    els.selectionSummary.textContent = state.selected.size ? "已选 " + state.selected.size + " 项" : "未选中";
  }

  function selectAll() {
    getFilteredEntries().forEach(function (entry) {
      state.selected.add(entry.path);
    });
    updateSelectionClasses();
    renderPreview();
    updateActionState();
  }

  function renderPreview() {
    var selectedPath = getPrimarySelectionPath();
    var entry = selectedPath ? findEntry(selectedPath) : null;

    if (!entry) {
      closeFilePreview();
      setPreviewPanelOpen(false);
      els.preview.className = "preview empty";
      els.preview.innerHTML = '<div class="empty-preview"><div class="preview-symbol">◇</div><p>选择素材查看详情</p></div>';
      els.metaPanel.innerHTML = "";
      return;
    }

    closeFilePreview();
    setPreviewPanelOpen(false);
    els.preview.className = "preview";
    if (entry.isDir || entry.isShortcut) {
      els.preview.innerHTML = '<div class="empty-preview"><div class="preview-folder">' + (entry.isShortcut ? "快捷方式" : "文件夹") + '</div><p>' + escapeHtml(entry.name) + '</p></div>';
    } else if (entry.ext === ".gif" && entry.size > 64 * 1024 * 1024) {
      els.preview.innerHTML = '<div class="empty-preview"><div class="preview-symbol">GIF</div><p>文件较大，已关闭首帧预览；可双击文件打开。</p></div>';
      setPreviewPanelOpen(true);
    } else if (entry.ext === ".gif") {
      els.preview.innerHTML = '<img class="preview-playable-image" src="' + pathToFileUrl(entry.path) + '" alt="' + escapeAttr(entry.name) + '"><div class="media-frame-caption">GIF 动画预览</div>';
      setPreviewPanelOpen(true);
    } else if (videoExts.has(entry.ext)) {
      els.preview.innerHTML = '<video class="preview-playable-video" src="' + pathToFileUrl(entry.path) + '" controls autoplay muted loop playsinline preload="metadata"></video><div class="media-frame-caption">视频预览（已静音）</div>';
      setPreviewPanelOpen(true);
    } else if (imageExts.has(entry.ext)) {
      els.preview.innerHTML = '<img src="' + pathToFileUrl(entry.path) + '" alt="' + escapeAttr(entry.name) + '">';
      setPreviewPanelOpen(true);
    } else if (audioExts.has(entry.ext)) {
      els.preview.innerHTML = '<audio src="' + pathToFileUrl(entry.path) + '" controls></audio>';
      setPreviewPanelOpen(true);
    } else {
      els.preview.innerHTML = '<div class="empty-preview"><div class="preview-symbol">' + escapeHtml(getIcon(entry)) + '</div><p>' + escapeHtml(entry.ext || "素材") + '</p></div>';
    }

    els.metaPanel.innerHTML = [
      metaRow("名称", entry.name),
      metaRow("类型", entry.isShortcut ? "快捷方式" : (entry.isDir ? "文件夹" : entry.ext)),
      metaRow("大小", entry.isDir ? "-" : formatBytes(entry.size)),
      metaRow("修改", formatDate(entry.mtime)),
      metaRow("路径", entry.path),
      entry.isShortcut ? metaRow("目标", entry.shortcutTarget || "双击后在插件内解析并跳转") : ""
    ].join("");
  }

  function openFilePreview(markup) {
    if (!els.filePreviewOverlay || !els.filePreviewOverlayContent) return;
    els.filePreviewOverlayContent.innerHTML = markup;
    els.filePreviewOverlay.hidden = false;
  }

  function setPreviewPanelOpen(open) {
    if (els.previewPanel) els.previewPanel.hidden = !open;
    if (els.contentArea) els.contentArea.classList.toggle("preview-open", !!open);
  }

  function closeFilePreview() {
    if (!els.filePreviewOverlay) return;
    els.filePreviewOverlay.hidden = true;
    if (els.filePreviewOverlayContent) els.filePreviewOverlayContent.innerHTML = "";
  }

  function metaRow(label, value) {
    return '<div class="meta-row"><div class="meta-label">' + escapeHtml(label) + '</div><div class="meta-value" title="' + escapeAttr(value) + '">' + escapeHtml(value) + '</div></div>';
  }

  function getImportableSelectedPaths() {
    return getImportablePathsFromPaths(getSelectedPaths());
  }

  function getImportablePathsFromPaths(paths) {
    var files = [];
    paths.forEach(function (item) {
      if (!exists(item)) return;
      var ext = path.extname(item).toLowerCase();
      if (isDirectory(item)) files = files.concat(collectImportableFiles(item));
      else if (aeImportExts.has(ext)) files.push(item);
    });
    return uniqueFiles(files);
  }

  function collectImportableFiles(folderPath) {
    var files = [];
    walkFolder(folderPath, function (filePath) {
      var ext = path.extname(filePath).toLowerCase();
      if (aeImportExts.has(ext)) files.push(filePath);
    });
    return files.sort(function (a, b) {
      return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    });
  }

  function walkFolder(folderPath, visitor) {
    var names;
    try {
      names = fs.readdirSync(folderPath);
    } catch (err) {
      return;
    }
    names.forEach(function (name) {
      var fullPath = path.join(folderPath, name);
      var stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (err2) {
        return;
      }
      if (stat.isDirectory()) walkFolder(fullPath, visitor);
      else visitor(fullPath);
    });
  }

  function importSelectedToAe(mode) {
    importPathsToAe(getSelectedPaths(), mode);
  }

  function replaceSelectedLayersWithSelection() {
    replaceLayersWithPaths(getSelectedPaths());
  }

  function replaceLayersWithPaths(sourcePaths) {
    var files = getImportablePathsFromPaths(sourcePaths);
    if (!files.length) {
      toast("请选择一个可替换图层的素材");
      return;
    }
    var payload = {
      paths: files,
      sequence: !!els.sequenceToggle.checked
    };
    toast("正在替换图层...");
    evalAe("afm_replaceSelectedLayers(" + JSON.stringify(JSON.stringify(payload)) + ")", "替换图层", function (result) {
      addRecentPath(state.cwd);
      toast(result || "替换完成");
    });
  }

  function importPathsToAe(sourcePaths, mode) {
    var files = getImportablePathsFromPaths(sourcePaths);
    if (!files.length) {
      toast("请选择可导入 AE 的素材或素材文件夹");
      return;
    }

    var asSequence = !!els.sequenceToggle.checked;
    if (asSequence) {
      files = reduceToSequenceHeads(files);
      if (!files.length) {
        toast("未找到可作为序列首帧的图片");
        return;
      }
    }

    var payload = {
      paths: files,
      sequence: asSequence,
      asComp: mode === "comp",
      asLayer: mode === "layer"
    };
    toast(mode === "layer" ? "正在从当前指针导入图层并匹配合成..." : (mode === "comp" ? "正在按合成导入..." : "正在导入 AE..."));
    evalAe("afm_importFiles(" + JSON.stringify(JSON.stringify(payload)) + ")", "导入 AE", function (result) {
      addRecentPath(state.cwd);
      toast(result || "导入完成");
    });
  }

  function collectSelectedCompToCurrentFolder() {
    var ok = window.confirm("整理合成会只保留当前选中合成相关内容，在当前目录创建以合成名称命名的文件夹，复制并重链素材后保存 AE 工程。继续前建议先保存当前项目。是否继续？");
    if (!ok) return;
    evalAe("afm_collectSelectedComp(" + JSON.stringify(state.cwd) + ")", "整理合成", function (result) {
      toast(result || "整理完成");
      openPath(state.cwd, { keepSelection: true });
    });
  }

  function duplicateSelectedComp() {
    if (state.collectProjectBusy) return;
    if (!window.confirm("复制当前合成会递归复制合成内部的预合成，并重新映射副本中的预合成图层，原合成不受影响。是否继续？")) return;
    toast("正在复制合成及内部预合成...");
    evalAe("afm_duplicateTargetComp()", "复制合成", function (result) {
      toast(result || "复制合成完成");
    }, { timeout: 30000 });
  }

  function exportActiveCompToCurrentFolder() {
    if (state.collectProjectBusy) return;
    if (!window.confirm("将使用 AfterCodecs / H.264 模板导出当前合成到当前文件夹，并立即开始渲染。是否继续？")) return;
    toast("正在配置导出并开始渲染...");
    evalAe("afm_exportCompConfigured(" + JSON.stringify(state.cwd) + ")", "导出", function (result) {
      var response;
      try { response = JSON.parse(result); } catch (err) { response = null; }
      if (!response || !response.ok) {
        toast((response && response.error) || result || "导出失败");
        return;
      }
      toast(response.message || "已完成导出");
    }, { timeout: 180000 });
  }

  function organizeProjectAssetsToCurrentFolder() {
    if (state.collectProjectBusy) return;
    var ok = window.confirm("整理素材只会整理 AE 项目面板中的素材和合成：创建分类文件夹并移动项目面板条目，不会复制外部文件、重链素材、打包工程或保存新的 AEP。是否继续？");
    if (!ok) return;
    toast("正在整理 AE 项目面板素材和合成...");
    evalAe("afm_organizeProjectPanelAssets()", "整理素材", function (result) {
      if (result && result.indexOf("ERROR:") === 0) {
        toast(result);
        return;
      }
      toast(result || "AE 项目面板整理完成");
    }, { timeout: 30000 });
  }

  function collectProjectToCurrentFolder(organizeByType) {
    if (state.collectProjectBusy) return;
    var confirmMessage = organizeByType
      ? "整理素材会按图片、视频、音频、PSD、设计文件等类型创建分类文件夹，并保存一份重链后的 AE 工程。原工程素材路径会被重定向到整理目录，建议先保存原工程。是否继续？"
      : "整理工程会复制当前 AE 工程引用的本地素材，并把整理后的工程保存到当前目录。当前打开的工程素材路径会被重定向到整理目录，继续前建议先保存原工程。是否继续？";
    var ok = window.confirm(confirmMessage);
    if (!ok) return;

    state.collectProjectBusy = true;
    updateActionState();
    toast(organizeByType ? "正在按类型扫描工程素材，请稍候..." : "正在扫描工程素材，请稍候...");
    evalAe("afm_prepareCollectProject(" + JSON.stringify(state.cwd) + "," + (organizeByType ? "true" : "false") + ")", organizeByType ? "整理素材准备" : "整理工程准备", function (result) {
      var plan;
      try {
        plan = JSON.parse(result);
      } catch (err) {
        abortCollectProject("整理工程准备失败：AE 返回了无效任务信息");
        return;
      }
      if (!plan || !plan.ok || !plan.jobId || !Array.isArray(plan.files)) {
        abortCollectProject(result || "整理工程准备失败");
        return;
      }
      processCollectProjectFile(plan, 0);
    }, {
      timeout: 30000,
      onError: abortCollectProject
    });
  }

  function processCollectProjectFile(plan, index) {
    if (!state.collectProjectBusy) return;
    if (index >= plan.files.length) {
      finishCollectProject(plan);
      return;
    }

    var file = plan.files[index];
    var taskLabel = plan.organizeByType ? "整理素材" : "整理工程";
    toast(taskLabel + " " + (index + 1) + "/" + plan.files.length + "：复制并重链 " + path.basename(file.sourcePath));
    copyFileAsync(file.sourcePath, file.targetPath, function (copyErr) {
      var copySucceeded = !copyErr;
      var copyFlag = copySucceeded ? "true" : "false";
      var script = "afm_collectProjectRelinkStep(" + JSON.stringify(plan.jobId) + "," + index + "," + copyFlag + ")";

      if (copyErr) {
        toast(taskLabel + " " + (index + 1) + "/" + plan.files.length + "：素材复制失败，将跳过重链");
      }
      evalAe(script, "整理工程重链", function (result) {
        var step;
        try {
          step = JSON.parse(result);
        } catch (err) {
          abortCollectProject("整理工程重链失败：AE 返回了无效结果");
          return;
        }
        if (!step || !step.ok) {
          abortCollectProject(step && step.error ? step.error : (result || "整理工程重链失败"));
          return;
        }
        processCollectProjectFile(plan, index + 1);
      }, {
        timeout: 120000,
        onError: abortCollectProject
      });
    });
  }

  function finishCollectProject(plan) {
    var taskLabel = plan.organizeByType ? "整理素材" : "整理工程";
    toast("正在保存" + taskLabel + "后的 AE 工程...");
    evalAe("afm_finishCollectProject(" + JSON.stringify(plan.jobId) + ")", taskLabel + "保存", function (result) {
      state.collectProjectBusy = false;
      updateActionState();
      toast(result || "整理工程完成");
      openPath(state.cwd, { keepSelection: true });
    }, {
      timeout: 120000,
      onError: abortCollectProject
    });
  }

  function abortCollectProject(message) {
    state.collectProjectBusy = false;
    updateActionState();
    toast(message || "整理工程已停止");
  }

  function captureCurrentFrame() {
    evalAe("afm_captureCurrentFrame(" + JSON.stringify(state.cwd) + ")", "截图", function (result) {
      if (!result || result.indexOf("ERROR:") === 0) {
        toast(result || "截图失败");
        return;
      }
      var savedPath = result.indexOf("OK:") === 0 ? result.slice(3) : result;
      toast("截图已保存");
      openPath(state.cwd, { keepSelection: true });
      window.setTimeout(function () {
        if (savedPath && exists(savedPath)) selectOnly(savedPath);
      }, 80);
    });
  }

  function locateSelectedAeItemPath() {
    evalAe("afm_getSelectedFootagePath()", "定位素材路径", function (result) {
      if (!result || result.indexOf("ERROR:") === 0) {
        toast(result || "未找到 AE 选中素材路径");
        return;
      }
      openPath(result);
    });
  }

  function evalAe(script, label, callback, options) {
    if (typeof options === "number") options = { timeout: options };
    options = options || {};
    var timeout = Number(options.timeout) || 8000;
    var finished = false;
    var timer = window.setTimeout(function () {
      if (finished) return;
      finished = true;
      var message = label + "没有收到 AE 响应，请关闭重开插件面板或重启 AE";
      toast(message);
      if (typeof options.onError === "function") options.onError(message);
    }, timeout);

    function fail(message) {
      finished = true;
      window.clearTimeout(timer);
      toast(message);
      if (typeof options.onError === "function") options.onError(message);
    }

    try {
      if (!cs || typeof cs.evalScript !== "function") {
        fail("AE 桥接不可用，请在 AE 扩展面板中打开插件");
        return;
      }

      cs.evalScript(script, function (result) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        result = String(result || "");
        if (result === "EvalScript error." || result.indexOf("EvalScript error") === 0) {
          fail(label + "失败：AE 脚本未加载，请重启 AE 后重试");
          return;
        }
        callback(result);
      });
    } catch (err) {
      fail(label + "调用失败：" + err.message);
    }
  }

  function reduceToSequenceHeads(files) {
    var heads = [];
    var seen = {};
    files.forEach(function (filePath) {
      var ext = path.extname(filePath).toLowerCase();
      if (!sequenceExts.has(ext)) return;
      var parsed = parseSequenceName(path.basename(filePath));
      var key = parsed ? path.dirname(filePath) + "|" + parsed.prefix + "|" + parsed.suffix + "|" + ext : filePath;
      if (!seen[key]) {
        seen[key] = filePath;
      } else {
        var current = parseSequenceName(path.basename(seen[key]));
        if (parsed && current && parsed.number < current.number) seen[key] = filePath;
      }
    });
    Object.keys(seen).forEach(function (key) { heads.push(seen[key]); });
    return heads;
  }

  function parseSequenceName(name) {
    var ext = path.extname(name).toLowerCase();
    var base = path.basename(name, ext);
    var match = base.match(/^(.*?)(\d+)(\D*)$/);
    if (!match) return null;
    return { prefix: match[1], number: parseInt(match[2], 10), suffix: match[3], padding: match[2].length };
  }

  function setClipboard(mode) {
    var paths = getSelectedPaths();
    if (!paths.length) {
      toast("先选择要处理的文件");
      return;
    }
    state.clipboard = { mode: mode, paths: paths };
    els.clipState.textContent = (mode === "copy" ? "复制 " : "移动 ") + paths.length + " 项";
    updateActionState();
    if (mode === "copy") {
      writeFileClipboard(paths, function (success) {
        toast(success ? "已复制文件，可在资源管理器中粘贴" : "已复制到插件剪贴板，系统剪贴板写入失败");
      });
    }
  }

  function pasteClipboard() {
    if (state.clipboard && state.clipboard.mode === "move") {
      pastePaths(state.clipboard.paths, "move");
      return;
    }

    // Read Explorer's current file list first so Ctrl+V works even when the
    // last copy was made outside the panel.
    readClipboardFiles(function (systemPaths) {
      var paths = systemPaths.length ? systemPaths : (state.clipboard && state.clipboard.paths ? state.clipboard.paths : []);
      if (!paths.length) {
        toast("剪贴板中没有可粘贴的文件");
        return;
      }
      state.clipboard = { mode: "copy", paths: paths };
      els.clipState.textContent = "复制 " + paths.length + " 项";
      updateActionState();
      pastePaths(paths, "copy");
    });
  }

  function pastePaths(sources, mode) {
    var failures = 0;

    function next(index) {
      if (index >= sources.length) {
        if (mode === "move") {
          state.clipboard = null;
          els.clipState.textContent = "未选择文件";
        }
        updateActionState();
        openPath(state.cwd);
        toast(failures ? "完成，失败 " + failures + " 项" : "操作完成");
        return;
      }

      var source = sources[index];
      var destination;
      try {
        destination = uniqueDestination(path.join(state.cwd, path.basename(source)));
      } catch (err) {
        failures += 1;
        next(index + 1);
        return;
      }

      if (mode === "copy") {
        copyRecursiveAsync(source, destination, function (err) {
          if (err) failures += 1;
          next(index + 1);
        });
      } else {
        fs.rename(source, destination, function (err) {
          if (err) failures += 1;
          next(index + 1);
        });
      }
    }

    next(0);
  }

  function copyFileAsync(source, destination, callback) {
    if (typeof fs.copyFile === "function") {
      fs.copyFile(source, destination, callback);
      return;
    }

    var settled = false;
    var input;
    var output;
    function finish(err) {
      if (settled) return;
      settled = true;
      callback(err || null);
    }

    try {
      input = fs.createReadStream(source);
      output = fs.createWriteStream(destination);
      input.on("error", finish);
      output.on("error", finish);
      output.on("close", function () { finish(null); });
      input.pipe(output);
    } catch (err) {
      finish(err);
    }
  }

  function copyRecursiveAsync(source, destination, callback) {
    fs.stat(source, function (statErr, stat) {
      if (statErr) {
        callback(statErr);
        return;
      }
      if (!stat.isDirectory()) {
        copyFileAsync(source, destination, callback);
        return;
      }

      fs.mkdir(destination, function (mkdirErr) {
        if (mkdirErr) {
          callback(mkdirErr);
          return;
        }
        fs.readdir(source, function (readErr, names) {
          if (readErr) {
            callback(readErr);
            return;
          }

          function copyNext(index) {
            if (index >= names.length) {
              callback(null);
              return;
            }
            copyRecursiveAsync(path.join(source, names[index]), path.join(destination, names[index]), function (err) {
              if (err) {
                callback(err);
                return;
              }
              copyNext(index + 1);
            });
          }

          copyNext(0);
        });
      });
    });
  }

  function createFolder() {
    var name = window.prompt("新建文件夹名称", "新建文件夹");
    if (!name) return;
    var target = uniqueDestination(path.join(state.cwd, sanitizeName(name)));
    try {
      fs.mkdirSync(target);
      openPath(state.cwd);
      selectOnly(target);
    } catch (err) {
      toast("创建失败：" + err.message);
    }
  }

  function renameEntry(entry) {
    if (!entry || !exists(entry.path)) {
      toast("文件不存在，无法重命名");
      return;
    }

    var currentName = entry.name;
    var ext = entry.isDir ? "" : path.extname(currentName);
    var baseName = entry.isDir ? currentName : path.basename(currentName, ext);
    var nextName = window.prompt("重命名", baseName);
    if (!nextName) return;

    nextName = sanitizeName(nextName);
    if (!entry.isDir && ext && path.extname(nextName) === "") {
      nextName += ext;
    }
    if (nextName === currentName) return;

    var target = path.join(path.dirname(entry.path), nextName);
    if (exists(target)) {
      toast("同名文件已存在");
      return;
    }

    try {
      fs.renameSync(entry.path, target);
      openPath(state.cwd);
      selectOnly(target);
      toast("已重命名");
    } catch (err) {
      toast("重命名失败：" + err.message);
    }
  }

  function previewEntry(entry) {
    if (!entry) return;
    selectOnly(entry.path);
    toast("已打开预览");
  }

  function renderPathLists() {
    renderPathList(els.recentPaths, state.settings.recentImportPaths || [], true, removeRecentPath);
  }

  function renderPathList(container, paths, removable, removeAction) {
    var validPaths = paths.map(normalizePathItem).filter(function (item) { return isDirectory(item.path); });
    if (!validPaths.length) {
      container.innerHTML = '<div class="empty-state path-empty"><span>⌁</span><strong>还没有最近目录</strong><small>打开一个素材文件夹<br>将在这里保留足迹</small></div>';
      return;
    }
    container.innerHTML = validPaths.map(function (item) {
      return [
        '<div class="path-item" title="' + escapeAttr(item.path) + '">',
        '<button class="path-open" data-path="' + escapeAttr(item.path) + '">',
        '<span class="recent-folder-icon" aria-hidden="true">▱</span><span class="path-label">' + escapeHtml(item.label || path.basename(item.path) || item.path) + '</span>',
        '<span class="path-full">' + escapeHtml(item.path) + '</span>',
        '</button>',
        removable ? '<button class="path-remove" data-path="' + escapeAttr(item.path) + '" title="移除">×</button>' : '',
        '</div>'
      ].join("");
    }).join("");

    Array.prototype.forEach.call(container.querySelectorAll(".path-open"), function (button) {
      button.addEventListener("click", function () { openPath(button.getAttribute("data-path")); });
    });
    Array.prototype.forEach.call(container.querySelectorAll(".path-remove"), function (button) {
      button.addEventListener("click", function () {
        if (removeAction) removeAction(button.getAttribute("data-path"));
      });
    });
  }

  function normalizePathItem(item) {
    if (item && typeof item === "object") return { label: item.label || "", path: item.path || "" };
    return { label: "", path: item };
  }

  function addRecentPath(folderPath) {
    state.settings.recentImportPaths = addUniquePath(state.settings.recentImportPaths || [], folderPath, 30);
    saveSettings();
    renderPathLists();
  }

  function removeRecentPath(folderPath) {
    state.settings.recentImportPaths = (state.settings.recentImportPaths || []).filter(function (item) {
      return pathKey(item) !== path.normalize(folderPath);
    });
    saveSettings();
    renderPathLists();
  }

  function clearRecentPaths() {
    state.settings.recentImportPaths = [];
    saveSettings();
    renderPathLists();
  }

  function addUniquePath(paths, folderPath, limit) {
    var normalized = path.normalize(folderPath);
    var next = [normalized].concat(paths.filter(function (item) { return pathKey(item) !== normalized; }));
    return next.slice(0, limit);
  }

  function pathKey(item) {
    return path.normalize(normalizePathItem(item).path || "");
  }

  function loadSettings() {
    try {
      if (exists(configPath)) {
        var parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        return {
          recentImportPaths: Array.isArray(parsed.recentImportPaths) ? parsed.recentImportPaths.slice(0, 30) : [],
          favoritePaths: Array.isArray(parsed.favoritePaths) ? parsed.favoritePaths : [],
          lastFolder: typeof parsed.lastFolder === "string" ? parsed.lastFolder : "",
          collapsedSections: parsed.collapsedSections && typeof parsed.collapsedSections === "object" ? parsed.collapsedSections : {},
          showImportableOnly: parsed.showImportableOnly !== false,
          thumbSize: clampThumbSize(parsed.thumbSize || 132),
        };
      }
    } catch (err) {
      // Ignore broken settings and recreate them on save.
    }
    return { recentImportPaths: [], favoritePaths: [], lastFolder: "", collapsedSections: {}, showImportableOnly: true, thumbSize: 132 };
  }

  function saveSettings() {
    try {
      ensureFolder(configDir);
      fs.writeFileSync(configPath, JSON.stringify(state.settings, null, 2), "utf8");
    } catch (err) {
      toast("配置保存失败");
    }
  }

  function ensureFolder(folder) {
    if (exists(folder)) return;
    var parent = path.dirname(folder);
    if (parent !== folder && !exists(parent)) ensureFolder(parent);
    if (!exists(folder)) fs.mkdirSync(folder);
  }

  function removePathSync(target) {
    if (!exists(target)) return;
    if (isDirectory(target)) {
      fs.readdirSync(target).forEach(function (name) {
        removePathSync(path.join(target, name));
      });
      fs.rmdirSync(target);
      return;
    }
    fs.unlinkSync(target);
  }

  function syncFilterControls() {
    els.importFilterToggle.checked = state.showImportableOnly;
    els.thumbSizeSlider.value = String(state.thumbSize);
    els.thumbSizeValue.textContent = String(state.thumbSize);
  }

  function setThumbSize(size, persist) {
    state.thumbSize = clampThumbSize(size);
    applyThumbSize();
    if (persist) {
      state.settings.thumbSize = state.thumbSize;
      saveSettings();
    }
  }

  function applyThumbSize() {
    document.documentElement.style.setProperty("--thumb-card-width", state.thumbSize + "px");
    document.documentElement.style.setProperty("--thumb-icon-height", Math.round(state.thumbSize * 0.7) + "px");
    document.documentElement.style.setProperty("--thumb-card-height", Math.round(state.thumbSize * 1.18) + 58 + "px");
    if (els.thumbSizeSlider) els.thumbSizeSlider.value = String(state.thumbSize);
    if (els.thumbSizeValue) els.thumbSizeValue.textContent = String(state.thumbSize);
  }

  function clampThumbSize(size) {
    size = Number(size) || 132;
    return Math.max(96, Math.min(220, Math.round(size / 8) * 8));
  }


  function updateActionState() {
    var selectedPaths = getSelectedPaths();
    var importable = getImportableSelectionSummary();
    var hasSelection = selectedPaths.length > 0;
    els.copyBtn.disabled = !hasSelection;
    els.cutBtn.disabled = !hasSelection;
    // Explorer may own the clipboard, so this action must remain available
    // even when the panel has not performed the last copy.
    els.pasteBtn.disabled = false;
    els.openFileBtn.disabled = !hasSelection;
    els.importBtn.classList.toggle("soft-disabled", !importable.available);
    els.importLayerBtn.classList.toggle("soft-disabled", !importable.available);
    els.replaceLayerBtn.classList.toggle("soft-disabled", !importable.available);
    els.importCompBtn.classList.toggle("soft-disabled", !importable.available);
    els.collectCompBtn.disabled = state.collectProjectBusy;
    els.collectProjectBtn.disabled = state.collectProjectBusy;
    els.organizeAssetsBtn.disabled = state.collectProjectBusy;
    els.duplicateCompBtn.disabled = state.collectProjectBusy;
    els.exportCompBtn.disabled = state.collectProjectBusy;
    els.importCount.textContent = importable.folderCount ? (importable.fileCount + " 项+" + importable.folderCount + " 文件夹") : (importable.fileCount + " 项");
    els.selectionSummary.textContent = hasSelection ? "已选 " + selectedPaths.length + " 项" : "未选中";
  }

  function getImportableSelectionSummary() {
    var fileCount = 0;
    var folderCount = 0;
    getSelectedPaths().forEach(function (item) {
      var entry = findEntry(item);
      if (!entry || entry.isShortcut) return;
      if (entry.isDir) folderCount += 1;
      else if (aeImportExts.has(entry.ext)) fileCount += 1;
    });
    return { fileCount: fileCount, folderCount: folderCount, available: fileCount > 0 || folderCount > 0 };
  }

  function setView(view) {
    state.view = view;
    els.gridViewBtn.classList.toggle("active", view === "grid");
    els.listViewBtn.classList.toggle("active", view === "list");
    renderFiles();
  }

  function findEntry(targetPath) {
    return state.entries.filter(function (entry) { return entry.path === targetPath; })[0] || null;
  }

  function getSelectedPaths() {
    return Array.from(state.selected).filter(function (item) { return exists(item); });
  }

  function getPrimarySelectionPath() {
    var selected = getSelectedPaths();
    return selected.length ? selected[selected.length - 1] : null;
  }

  function revealPath(target) {
    try {
      if (platform === "win32") {
        childProcess.execFile("explorer.exe", ["/select,", target], { windowsHide: true });
      } else if (platform === "darwin") {
        childProcess.execFile("open", ["-R", target]);
      } else {
        childProcess.execFile("xdg-open", [isDirectory(target) ? target : path.dirname(target)]);
      }
    } catch (err) {
      toast("无法打开系统文件管理器");
    }
  }

  function openExternal(target) {
    try {
      if (platform === "win32") {
        childProcess.execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Start-Process -LiteralPath $args[0]", target], { windowsHide: true });
      } else if (platform === "darwin") {
        childProcess.execFile("open", [target]);
      } else {
        childProcess.execFile("xdg-open", [target]);
      }
    } catch (err) {
      toast("无法打开文件");
    }
  }

  function openShortcut(entry) {
    toast("正在解析快捷方式...");
    resolveShortcutTargetAsync(entry.path, function (target) {
      if (!target) {
        toast("无法解析快捷方式目标，未执行外部打开");
        return;
      }
      entry.shortcutTarget = target;
      openPath(target);
    });
  }

  function sendSelectionToFreeImage() {
    var selected = getSelectedPaths();
    if (!selected.length) return toast("请先选择要用于 AI 生图的图片");
    var images = selected.filter(function (filePath) {
      try { return /\.(png|jpe?g|webp)$/i.test(filePath) && fs.statSync(filePath).isFile(); }
      catch (ignore) { return false; }
    });
    if (!images.length) return toast("参考图支持 PNG、JPG、WEBP；视频或其他格式请先截图或转换为图片");
    if (images.length > 8) return toast("一次最多发送 8 张参考图，请减少选择");
    if (images.length !== selected.length && !window.confirm("将发送 " + images.length + " 张图片，跳过 " + (selected.length - images.length) + " 项不支持或不存在的文件，继续吗？")) return;
    try {
      var handoffDir = path.join(process.env.APPDATA || os.homedir(), "AEFileManager-Anime");
      if (!fs.existsSync(handoffDir)) fs.mkdirSync(handoffDir, { recursive: true });
      var handoffFile = path.join(handoffDir, "ai-free-image-handoff.json");
      fs.writeFileSync(handoffFile + ".tmp", JSON.stringify({ paths: images, source: "file-manager", target: "free-image-view", createdAt: Date.now() }), "utf8");
      fs.renameSync(handoffFile + ".tmp", handoffFile);
      if (window.AFMUpdates) window.AFMUpdates.mark("file-to-ai-20261013");
      window.location.href = "./ai-image.html";
    } catch (err) { toast("无法发送到 AI 生图：" + err.message); }
  }

  function showContextMenu(entry, x, y) {
    hideContextMenu();
    var items = [];
    if (entry.isShortcut) {
      items.push({ label: "打开预览", action: function () { previewEntry(entry); } });
      items.push({ label: "打开快捷路径", action: function () { openShortcut(entry); } });
      items.push({ label: "重命名", action: function () { renameEntry(entry); } });
      items.push({ label: "复制快捷方式路径", action: function () { copyText(entry.path); } });
      items.push({ label: "复制目标路径", action: function () { copyShortcutTarget(entry); } });
    } else if (entry.isDir) {
      items.push({ label: "打开预览", action: function () { previewEntry(entry); } });
      items.push({ label: "打开文件夹", action: function () { openPath(entry.path); } });
      items.push({ label: "重命名", action: function () { renameEntry(entry); } });
      items.push({ label: "批量导入此文件夹", action: function () { selectOnly(entry.path); importSelectedToAe("footage"); } });
      items.push({ label: "复制文件夹路径", action: function () { copyText(entry.path); } });
      items.push({ label: "系统定位", action: function () { revealPath(entry.path); } });
    } else {
      items.push({ label: "打开预览", action: function () { previewEntry(entry); } });
      items.push({ label: "打开所在文件夹", action: function () { openPath(entry.path); } });
      items.push({ label: "重命名", action: function () { renameEntry(entry); } });
      items.push({ label: "导入 AE", action: function () { selectOnly(entry.path); importSelectedToAe("footage"); } });
      items.push({ label: "导入图层", action: function () { selectOnly(entry.path); importSelectedToAe("layer"); } });
      items.push({ label: "用于 AI 生图", action: function () { if (!state.selected.has(entry.path)) selectOnly(entry.path); sendSelectionToFreeImage(); } });
      items.push({ label: "复制文件路径", action: function () { copyText(entry.path); } });
      items.push({ label: "系统定位", action: function () { revealPath(entry.path); } });
    }

    items.push({ label: "复制文件", action: function () { selectOnly(entry.path); setClipboard("copy"); } });
    items.push({ label: "剪切文件", action: function () { selectOnly(entry.path); setClipboard("move"); } });
    items.push({ label: "粘贴到当前文件夹", action: pasteClipboard });
    items.push({ label: "删除", action: function () { deleteContextSelection(entry); } });

    renderContextMenu(items, x, y);
  }

  function showFileGridContextMenu(x, y) {
    var items = [];
    var hasSelection = getSelectedPaths().length > 0;

    if (hasSelection) {
      items.push({ label: "用于 AI 生图", action: sendSelectionToFreeImage });
      items.push({ label: "复制选中文件", action: function () { setClipboard("copy"); } });
      items.push({ label: "剪切选中文件", action: function () { setClipboard("move"); } });
      items.push({ label: "删除选中文件", action: function () { deleteContextSelection({ path: getPrimarySelectionPath() }); } });
    }
    items.push({ label: "粘贴到当前文件夹", action: pasteClipboard });
    items.push({ label: "新建文件夹", action: createFolder });
    items.push({ label: "刷新当前文件夹", action: function () { openPath(state.cwd, { keepSelection: true }); } });
    items.push({ label: "系统定位当前文件夹", action: function () { revealPath(state.cwd); } });

    renderContextMenu(items, x, y);
  }

  function renderContextMenu(items, x, y) {
    els.contextMenu.innerHTML = items.map(function (item, index) {
      return '<button class="context-item" data-index="' + index + '">' + escapeHtml(item.label) + '</button>';
    }).join("");
    Array.prototype.forEach.call(els.contextMenu.querySelectorAll(".context-item"), function (button) {
      button.addEventListener("click", function () {
        var item = items[Number(button.getAttribute("data-index"))];
        hideContextMenu();
        item.action();
      });
    });

    els.contextMenu.hidden = false;
    var left = Math.min(x, window.innerWidth - 206);
    var top = Math.min(y, window.innerHeight - 250);
    els.contextMenu.style.left = Math.max(8, left) + "px";
    els.contextMenu.style.top = Math.max(8, top) + "px";
  }

  function hideContextMenu() {
    if (els.contextMenu) els.contextMenu.hidden = true;
  }

  function deleteContextSelection(entry) {
    var targets = state.selected.has(entry.path) ? getSelectedPaths() : [entry.path];
    if (!targets.length) return;
    if (!window.confirm("确定删除选中的 " + targets.length + " 个项目吗？此操作不可撤销。")) return;

    var deleted = 0;
    targets.forEach(function (target) {
      try {
        removePathSync(target);
        deleted += 1;
      } catch (err) {
        toast("删除失败：" + err.message);
      }
    });
    state.selected.clear();
    state.lastSelected = null;
    if (deleted) {
      loadDirectory();
      toast("已删除 " + deleted + " 个项目");
    }
  }

  function copyShortcutTarget(entry) {
    resolveShortcutTargetAsync(entry.path, function (target) {
      if (!target) {
        toast("无法解析快捷方式目标");
        return;
      }
      entry.shortcutTarget = target;
      copyText(target);
      renderPreview();
    });
  }

  function copyText(text) {
    var input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
    toast("已复制路径");
  }

  function resolveShortcutTargetAsync(shortcutPath, callback) {
    if (platform !== "win32") {
      callback(null);
      return;
    }
    var command = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
      "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($args[0]);",
      "Write-Output $s.TargetPath"
    ].join(" ");
    childProcess.execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
      shortcutPath
    ], { windowsHide: true, encoding: "utf8", timeout: 6000 }, function (err, stdout) {
      if (err) {
        callback(null);
        return;
      }
      var output = String(stdout || "").trim();
      if (!output) {
        callback(null);
        return;
      }
      var expanded = expandEnvPath(output);
      callback(expanded && exists(expanded) ? expanded : null);
    });
  }

  function expandEnvPath(target) {
    var expanded = String(target || "").replace(/%([^%]+)%/g, function (_, name) {
      return process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()] || "";
    });
    return expanded ? path.normalize(expanded) : "";
  }

  function getConfigDir() {
    if (platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AEFileManager-Anime");
    if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AEFileManager-Anime");
    return path.join(os.homedir(), ".config", "AEFileManager-Anime");
  }

  function resolveStartPath() {
    try {
      var saved = loadSettings().lastFolder;
      if (saved && exists(saved)) return path.normalize(saved);
    } catch (err) {}
    var candidates = [
      path.join(os.homedir(), "Desktop"),
      path.join(os.homedir(), "桌面"),
      path.join(os.homedir(), "Downloads"),
      os.homedir()
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      if (exists(candidates[i])) return candidates[i];
    }
    return os.homedir();
  }

  function normalizeLoosePath(raw) {
    var value = String(raw || "").trim();
    if (/^file:\/\//i.test(value)) {
      value = value.replace(/^file:\/+/i, "");
      value = value.replace(/^\/([A-Za-z]:)/, "$1");
    }
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      // Keep original string if it is not URI encoded.
    }
    if (platform === "win32") {
      value = value.replace(/\//g, "\\");
      if (/^[A-Za-z]\|/.test(value)) value = value.charAt(0) + ":" + value.slice(2);
    }
    return path.normalize(value);
  }

  function pathToFileUrl(filePath) {
    return "file:///" + encodeURI(filePath.replace(/\\/g, "/")).replace(/#/g, "%23");
  }

  function getIcon(entry) {
    if (entry.isShortcut) return ".LNK";
    if (entry.isDir) return "DIR";
    if (entry.ext) return entry.ext.toUpperCase();
    return "FILE";
  }

  function getThumbnailHtml(entry) {
    if (entry.isShortcut) return '<div class="folder-thumb shortcut-thumb"><span class="shortcut-badge">↗</span></div>';
    if (entry.isDir) return '<div class="folder-thumb"></div>';
    if (entry.ext === ".gif") return '<canvas class="thumb media-frame-canvas" data-media-src="' + escapeAttr(pathToFileUrl(entry.path)) + '" data-media-kind="gif" aria-label="GIF 首帧"></canvas><span class="media-frame-badge">GIF</span>';
    if (imageExts.has(entry.ext)) return '<img class="thumb lazy-thumb" data-src="' + escapeAttr(pathToFileUrl(entry.path)) + '" alt="" decoding="async">';
    if (videoExts.has(entry.ext)) return '<canvas class="thumb media-frame-canvas" data-media-src="' + escapeAttr(pathToFileUrl(entry.path)) + '" data-media-kind="video" aria-label="视频首帧"></canvas><span class="media-frame-badge">视频</span>';
    if (audioExts.has(entry.ext)) return '<div class="generic-thumb audio-thumb"><span>♪</span></div>';
    return '<div class="generic-thumb"><span>' + escapeHtml(getIcon(entry)) + '</span></div>';
  }

  function uniqueFiles(files) {
    var seen = {};
    return files.filter(function (filePath) {
      var key = path.normalize(filePath).toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function uniqueDestination(destination) {
    if (!exists(destination)) return destination;
    var dir = path.dirname(destination);
    var ext = path.extname(destination);
    var base = path.basename(destination, ext);
    var index = 1;
    var next;
    do {
      next = path.join(dir, base + " copy " + index + ext);
      index += 1;
    } while (exists(next));
    return next;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0) + " " + units[index];
  }

  function formatDate(date) {
    return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function exists(target) {
    try {
      fs.accessSync(target);
      return true;
    } catch (err) {
      return false;
    }
  }

  function isDirectory(target) {
    try {
      return fs.statSync(target).isDirectory();
    } catch (err) {
      return false;
    }
  }

  function sanitizeName(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "新建文件夹";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  var toastTimer = null;
  function toast(message) {
    window.clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    toastTimer = window.setTimeout(function () {
      els.toast.classList.remove("show");
    }, 2600);
  }

  try {
    init();
  } catch (err) {
    showFatalError(err && err.message ? err.message : String(err));
  }

  function showFatalError(message) {
    var existing = document.getElementById("fatalError");
    if (existing) {
      existing.textContent = "插件启动失败：" + message;
      return;
    }
    var box = document.createElement("div");
    box.id = "fatalError";
    box.style.cssText = "position:fixed;inset:12px;z-index:9999;padding:14px;border:1px solid #ef6a6a;border-radius:8px;background:#201719;color:#f5d7d7;font:13px Segoe UI,Microsoft YaHei,sans-serif;white-space:pre-wrap;overflow:auto;";
    box.textContent = "插件启动失败：" + message;
    document.body.appendChild(box);
  }
}());
