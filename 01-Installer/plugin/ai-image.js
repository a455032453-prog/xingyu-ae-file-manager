(function () {
  "use strict";

  var nodeRequire = window.require || (window.parent && window.parent.require);
  if (!nodeRequire) {
    document.body.innerHTML = "<div style='padding:20px;color:#f1f5f1;font:13px Microsoft YaHei'>AI 工具需要通过 After Effects CEP 面板打开，并启用 Node.js。</div>";
    return;
  }

  var fs = nodeRequire("fs");
  var path = nodeRequire("path");
  var os = nodeRequire("os");
  var childProcess = nodeRequire("child_process");
  var cs = typeof CSInterface !== "undefined" ? new CSInterface() : (window.CSInterface ? new window.CSInterface() : null);
  var extensionRoot = getExtensionRoot();
  var appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  var dataDir = path.join(appData, "AEFileManager-Anime");
  var requestDir = path.join(dataDir, "requests");
  var referenceDir = path.join(dataDir, "reference-images");
  var generatedDir = path.join(dataDir, "generated-images");
  var bundledService = path.join(extensionRoot, "ai-service", "ai-expression-service.js");
  var toastTimer = null, serviceStarted = false;
  function getExtensionRoot() {
    var filePath = decodeURI(String(location.pathname || "")).replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, path.sep);
    return path.dirname(filePath);
  }
  var el = {};
  var freeImageSettingsFile = path.join(dataDir, "AE_ScriptManager_free_image_settings.json");
  var freeImagePromptsFile = path.join(dataDir, "AE_ScriptManager_free_image_prompts.json");
  var maxReferences = 8, referenceInputBusy = {};
  var previewReturnFocus = null, currentModal = null;
  var freeGeneratedFiles = [], resultPageSize = 6;
  var resultGalleries = { free: { page: 0, ticket: 0 } };
  var selectedFreeImagePath = "", busyFreeImage = false, freeImageTimer = null;
  var selectedFreePromptId = "", freeModelCapabilities = null, modelCheckTicket = 0;
  var state = { freeImageSettings: {}, freePrompts: [], freeReferences: [] };
  function init() {
    cacheElements(); ensureDataFolders(); loadSharedData();
    el.checkServiceBtn.addEventListener("click", function () { checkService(false); });
    window.addEventListener("afm-ai-config-saved", function () { serviceStarted = false; el.globalStatus.textContent = "AI 配置已保存，正在刷新模型"; freeModelCapabilities = null; refreshFreeModels(); });
    window.addEventListener("afm-ai-config-cleared", function () { serviceStarted = false; modelCheckTicket++; freeModelCapabilities = null; el.refreshFreeModelsBtn.disabled = false; el.globalStatus.textContent = "本机秘钥已清空，请重新填写"; el.freeImageModelStatus.textContent = "秘钥已清空，后续生成需重新配置。"; });
    bindResultGalleries(); bindFreeImageEvents(); bindReferenceInputs(); bindModalEvents(); receiveFileManagerImages();
    checkService(true);
  }

  function receiveFileManagerImages() {
    var transferFile = path.join(dataDir, "ai-free-image-handoff.json");
    var transfer = readJson(transferFile, null);
    if (!transfer || transfer.target !== "free-image-view" || !Array.isArray(transfer.paths)) return;
    var previous = state.freeReferences.slice(0);
    var accepted = 0;
    var duplicates = 0;
    var skipped = 0;
    transfer.paths.forEach(function (filePath) {
      try {
        if (typeof filePath !== "string" || !/\.(png|jpe?g|webp)$/i.test(filePath) || !fs.statSync(filePath).isFile()) { skipped++; return; }
        if (state.freeReferences.indexOf(filePath) >= 0) { duplicates++; return; }
        if (state.freeReferences.length >= maxReferences) { skipped++; return; }
        state.freeReferences.push(filePath);
        accepted++;
      } catch (ignore) { skipped++; }
    });
    try {
      state.freeImageSettings.referencePaths = state.freeReferences.slice(0);
      writeJson(freeImageSettingsFile, state.freeImageSettings);
    } catch (err) {
      state.freeReferences = previous;
      state.freeImageSettings.referencePaths = previous;
      return showToast("参考图保存失败，可重新打开重试：" + err.message);
    }
    try { fs.unlinkSync(transferFile); } catch (ignoreDelete) {}
    renderFreeImageReferences();
    showToast("已添加 " + accepted + " 张参考图" + (duplicates ? "，" + duplicates + " 张已存在" : "") + (skipped ? "；跳过 " + skipped + " 项（文件不可用或超过 8 张上限）" : ""));
  }

  function cacheElements() {
    Array.prototype.forEach.call(document.querySelectorAll('[id]'), function (node) { el[node.id] = node; });
  }

  function ensureDataFolders() {
    [dataDir, requestDir, referenceDir, generatedDir].forEach(function (folder) {
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    });
  }

  function loadSharedData() {
    state.freeImageSettings = readJson(freeImageSettingsFile, {});
    state.freePrompts = readJson(freeImagePromptsFile, [
      { id: "free_cinematic", name: "电影感主视觉", text: "电影感主视觉，主体清晰，光影有层次，画面细节丰富，保留适合后期排版和动画的干净区域。" },
      { id: "free_product", name: "产品展示", text: "高质感产品展示图，材质真实，构图简洁，商业摄影级光影，主体突出，背景干净。" }
    ]);
    state.freePrompts = Array.isArray(state.freePrompts) ? state.freePrompts : [];
    state.freeReferences = (state.freeImageSettings.referencePaths || []).filter(function (item) {
      return typeof item === "string" && fs.existsSync(item);
    }).slice(0, maxReferences);
    el.freeImagePrompt.value = state.freeImageSettings.prompt || "";
    selectedFreePromptId = state.freeImageSettings.presetId || "";
    var legacyRatios = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3", "1280x720": "16:9", "720x1280": "9:16" };
    el.freeImageSize.value = state.freeImageSettings.ratio || legacyRatios[state.freeImageSettings.size] || "1:1";
    if (!el.freeImageSize.value) el.freeImageSize.value = "1:1";
    el.freeImageResolution.value = state.freeImageSettings.resolution || "1K";
    if (!el.freeImageResolution.value) el.freeImageResolution.value = "1K";
    el.freeImageModel.value = state.freeImageSettings.model || "gpt-image-2";
    if (!el.freeImageModel.value) el.freeImageModel.value = "gpt-image-2";
    el.freeImageCount.value = String(Math.max(1, Math.min(4, Number(state.freeImageSettings.count || 1))));
  }

  function readJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(filePath, value) {
    var tempPath = filePath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  }

  function saveFreeImageSettings() {
    state.freeImageSettings = {
      prompt: el.freeImagePrompt.value,
      presetId: selectedFreePromptId,
      ratio: el.freeImageSize.value,
      resolution: el.freeImageResolution.value,
      model: el.freeImageModel.value,
      count: Number(el.freeImageCount.value),
      referencePaths: state.freeReferences.slice(0)
    };
    try { writeJson(freeImageSettingsFile, state.freeImageSettings); return true; } catch (err) { showToast("保存 AI 生图设置失败：" + err.message); return false; }
  }

  function saveFreeImagePrompts() {
    try { writeJson(freeImagePromptsFile, state.freePrompts); return true; } catch (err) { showToast("保存 AI 生图提示词失败：" + err.message); return false; }
  }

  function referencePaths() { return state.freeReferences; }

  function feedReferencePaths(view, paths) {
    var before = state.freeReferences.length;
    addFreeImageReferences(paths);
    return state.freeReferences.length - before;
  }

  function importReferenceFiles(view, fileList) {
    if (referenceInputBusy[view]) return showToast("正在读取参考图，请稍候");
    if (referencePaths(view).length >= maxReferences) return showToast("参考图已满 8 张，请先移除再添加");
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return showToast("没有可读取的图片，请拖入本地图片或点击粘贴图片");
    referenceInputBusy[view] = true;
    var collected = [], skipped = 0, index = 0;
    function next() {
      if (index >= files.length) {
        referenceInputBusy[view] = false;
        var added = feedReferencePaths(view, collected);
        if (skipped || added < collected.length) showToast("已添加 " + added + " 张；部分图片重复、格式不支持、超过 32MB 或超过 8 张上限");
        return;
      }
      var file = files[index++];
      if (collected.length + referencePaths(view).length >= maxReferences) { skipped++; return next(); }
      if (file.path) {
        try {
          if (!/\.(png|jpe?g|webp)$/i.test(file.path) || !fs.statSync(file.path).isFile()) throw new Error("不支持的文件");
          if (collected.indexOf(file.path) < 0 && referencePaths(view).indexOf(file.path) < 0) collected.push(file.path);
          else skipped++;
        } catch (ignorePath) { skipped++; }
        return next();
      }
      var extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[file.type];
      if (!extension || file.size > 32 * 1024 * 1024) { skipped++; return next(); }
      var reader = new FileReader();
      reader.onerror = function () { skipped++; next(); };
      reader.onload = function () {
        try {
          var buffer = nodeRequire("buffer").Buffer.from(String(reader.result).split(",")[1], "base64");
          var out = path.join(referenceDir, "pasted-" + Date.now() + "-" + Math.random().toString(16).slice(2) + extension);
          fs.writeFileSync(out, buffer);
          collected.push(out);
        } catch (ignoreWrite) { skipped++; }
        next();
      };
      reader.readAsDataURL(file);
    }
    next();
  }

  function pasteReferenceImage(view) {
    if (referenceInputBusy[view]) return showToast("正在读取参考图，请稍候");
    if (referencePaths(view).length >= maxReferences) return showToast("参考图已满 8 张，请先移除再添加");
    if (process.platform !== "win32") return showToast("请在参考图区按 Ctrl+V / Cmd+V 粘贴图片，或拖入本地图片");
    referenceInputBusy[view] = true;
    showToast("正在读取剪贴板图片…");
    try {
      childProcess.execFile("powershell.exe", ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(extensionRoot, "lib", "read-reference-clipboard.ps1")], {
        windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
        env: Object.assign({}, process.env, { AFM_REFERENCE_CLIPBOARD_DIR: referenceDir })
      }, function (error, stdout) {
        referenceInputBusy[view] = false;
        var result;
        try { result = JSON.parse(String(stdout || "").replace(/^\uFEFF/, "").trim()); } catch (ignore) {}
        if (error || !result || !result.ok) return showToast(result && result.error ? result.error : "读取剪贴板失败，请重新复制图片后重试，或在参考图区按 Ctrl+V");
        if (!Array.isArray(result.paths) || !result.paths.length) return showToast("剪贴板没有图片；请复制本地 PNG/JPG/WEBP 文件，或先截图再粘贴");
        var added = feedReferencePaths(view, result.paths);
        if (added < result.paths.length) showToast("已添加 " + added + " 张，跳过重复图片或超过 8 张上限的图片");
      });
    } catch (err) { referenceInputBusy[view] = false; showToast("读取剪贴板失败：" + err.message); }
  }

  function importAEReference(view, layers) {
    if (referenceInputBusy[view]) return showToast("正在读取参考图，请稍候");
    var available = maxReferences - referencePaths(view).length;
    if (available <= 0) return showToast("参考图已满 8 张，请先移除再添加");
    referenceInputBusy[view] = true;
    var script = layers ? "afm_exportSelectedLayersForAi(" + JSON.stringify(referenceDir) + "," + available + ")" : "afm_getSelectedFootagePath()";
    showToast(layers ? "正在导出选中图层当前帧…" : "正在读取 AE 选中素材…");
    evalAe(script, function (error, result) {
      referenceInputBusy[view] = false;
      if (error) return showToast(error);
      if (!layers) {
        if (!result || result.indexOf("ERROR:") === 0) return showToast(result || "请在项目面板中选择本地图片素材");
        return feedReferencePaths(view, [result]);
      }
      var response;
      try { response = JSON.parse(result); } catch (ignore) {}
      if (!response || !response.ok) return showToast(response && response.error ? response.error : "图层导出失败，请重新打开插件后重试");
      var added = feedReferencePaths(view, response.paths || []);
      if (response.warnings && response.warnings.length) showToast("已添加 " + added + " 张；" + response.warnings.join("；"));
    });
  }

  function bindReferenceInputs() {
    [
      { view: "free-image-view", panel: document.querySelector(".free-reference-panel"), drop: el.freeReferenceDrop, picker: el.freeImagePicker, paste: el.pasteFreeReferencesBtn, footage: el.useAESelectedBtn, layers: el.useFreeAELayersBtn }
    ].forEach(function (input) {
      if (input.view === "free-image-view") input.drop.addEventListener("click", function () { input.picker.click(); });
      input.drop.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.picker.click(); }
      });
      ["dragenter", "dragover"].forEach(function (name) {
        input.panel.addEventListener(name, function (event) { event.preventDefault(); input.drop.classList.add("dragging"); });
      });
      input.panel.addEventListener("dragleave", function (event) {
        if (!input.panel.contains(event.relatedTarget)) input.drop.classList.remove("dragging");
      });
      input.panel.addEventListener("drop", function (event) {
        event.preventDefault(); event.stopPropagation(); input.drop.classList.remove("dragging");
        importReferenceFiles(input.view, event.dataTransfer && event.dataTransfer.files);
      });
      input.paste.addEventListener("click", function () { pasteReferenceImage(input.view); });
      input.footage.addEventListener("click", function () { importAEReference(input.view, false); });
      input.layers.addEventListener("click", function () { importAEReference(input.view, true); });
    });
    document.addEventListener("paste", function (event) {
      var view = document.querySelector(".tool-view.active");
      if (!view || view.id !== "free-image-view" || !el.toolModal.hidden || !el.previewModal.hidden) return;
      var data = event.clipboardData;
      var files = data ? Array.prototype.slice.call(data.files || []) : [];
      if (!files.length && data) Array.prototype.forEach.call(data.items || [], function (item) {
        if (item.kind === "file") { var file = item.getAsFile(); if (file) files.push(file); }
      });
      if (files.length) { event.preventDefault(); importReferenceFiles(view.id, files); return; }
      var target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (process.platform === "win32") { event.preventDefault(); pasteReferenceImage(view.id); }
    });
  }

  function loadResultPreview(img, filePath, status, complete, readBytesFirst) {
    var ticket = (img._previewTicket || 0) + 1;
    img._previewTicket = ticket;
    var retried = false;
    img.hidden = true;
    status.textContent = "正在加载预览…";
    img.onload = function () {
      if (img._previewTicket !== ticket) return;
      img.hidden = false;
      status.textContent = img.naturalWidth + " × " + img.naturalHeight;
      if (complete) complete(true);
    };
    function fail() {
      if (img._previewTicket !== ticket) return;
      img.hidden = true;
      status.textContent = "无法读取预览，请打开目录检查图片文件或刷新重试。";
      if (complete) complete(false);
    }
    img.onerror = function () {
      if (img._previewTicket !== ticket) return;
      if (retried) return fail();
      retried = true;
      try {
        fs.readFile(filePath, function (error, bytes) {
          if (img._previewTicket !== ticket) return;
          if (error || !bytes || !bytes.length) return fail();
          var mime = /\.webp$/i.test(filePath) ? "image/webp" : (/\.jpe?g$/i.test(filePath) ? "image/jpeg" : "image/png");
          img.src = "data:" + mime + ";base64," + bytes.toString("base64");
        });
      } catch (error) { fail(); }
    };
    // Local file images can taint a canvas even when direct display succeeds.
    // Thumbnail decoding therefore starts from local bytes, not a file URL.
    if (readBytesFirst) img.onerror();
    else img.src = toFileUrl(filePath);
  }

  function openImagePreview(filePath) {
    previewReturnFocus = document.activeElement;
    el.previewModal.hidden = false;
    loadResultPreview(el.previewModalImage, filePath, el.previewStatus);
    el.closePreviewBtn.focus();
  }

  function closeImagePreview() {
    el.previewModal.hidden = true;
    el.previewModalImage._previewTicket = (el.previewModalImage._previewTicket || 0) + 1;
    el.previewModalImage.onload = null;
    el.previewModalImage.onerror = null;
    el.previewModalImage.removeAttribute("src");
    if (previewReturnFocus && document.contains(previewReturnFocus)) previewReturnFocus.focus();
    previewReturnFocus = null;
  }

  function bindFreeImageEvents() {
    el.freeImagePicker.addEventListener("change", function () {
      importReferenceFiles("free-image-view", el.freeImagePicker.files);
      el.freeImagePicker.value = "";
    });
    el.chooseFreeImagesBtn.addEventListener("click", function () { el.freeImagePicker.click(); });
    el.captureFreeFrameBtn.addEventListener("click", function () {
      evalAe("afm_captureCurrentFrame(" + JSON.stringify(referenceDir) + ")", function (error, result) {
        if (error || !result || result.indexOf("OK:") !== 0) return showToast(error || result || "截图失败，请先打开合成");
        addFreeImageReferences([result.substring(3)]);
      });
    });
    el.freeImageReferenceList.addEventListener("click", function (event) {
      var item = closestWithClass(event.target, "free-reference-item");
      var action = closestWithAttribute(event.target, "data-action");
      if (!item) return;
      if (action && action.getAttribute("data-action") === "remove") {
        state.freeReferences.splice(Number(item.getAttribute("data-index")), 1);
        renderFreeImageReferences();
        saveFreeImageSettings();
      }
      if (action && (action.getAttribute("data-action") === "left" || action.getAttribute("data-action") === "right")) {
        var index = Number(item.getAttribute("data-index"));
        var next = index + (action.getAttribute("data-action") === "left" ? -1 : 1);
        if (next >= 0 && next < state.freeReferences.length) swap(state.freeReferences, index, next);
        renderFreeImageReferences();
        saveFreeImageSettings();
      }
    });
    el.freeImagePromptCards.addEventListener("click", function (event) {
      var card = closestWithAttribute(event.target, "data-free-prompt-id");
      if (!card) return;
      var id = card.getAttribute("data-free-prompt-id");
      if (closestWithClass(event.target, "free-prompt-delete")) return deleteCurrentFreePrompt(id);
      useFreePrompt(id);
    });
    el.freeImagePromptCards.addEventListener("dblclick", function (event) {
      if (closestWithClass(event.target, "free-prompt-delete")) return;
      var card = closestWithAttribute(event.target, "data-free-prompt-id");
      if (card) editFreePrompt(card.getAttribute("data-free-prompt-id"));
    });
    el.freeImagePrompt.addEventListener("input", saveFreeImageSettings);
    el.freeImageSize.addEventListener("change", saveFreeImageSettings);
    el.freeImageResolution.addEventListener("change", saveFreeImageSettings);
    el.freeImageModel.addEventListener("change", function () { saveFreeImageSettings(); updateFreeModelStatus(); });
    el.refreshFreeModelsBtn.addEventListener("click", refreshFreeModels);
    el.freeImageCount.addEventListener("change", saveFreeImageSettings);
    el.saveFreeImagePromptBtn.addEventListener("click", function () { editFreePrompt(""); });
    el.generateFreeImageBtn.addEventListener("click", generateFreeImage);
    el.refreshFreeImagesBtn.addEventListener("click", refreshFreeImages);
    el.previewFreeImageBtn.addEventListener("click", previewFreeImage);
    el.deleteFreeImageBtn.addEventListener("click", deleteFreeImage);
    el.openFreeImageFolderBtn.addEventListener("click", function () { revealFolder(generatedDir); });
    el.importFreeImageBtn.addEventListener("click", importFreeImage);
    renderFreeImagePrompts();
    renderFreeImageReferences();
    refreshFreeImages();
    refreshFreeModels();
  }

  function addFreeImageReferences(paths) {
    var accepted = 0;
    (paths || []).forEach(function (filePath) {
      if (!filePath || !fs.existsSync(filePath) || state.freeReferences.indexOf(filePath) >= 0 || state.freeReferences.length >= maxReferences) return;
      if (!/\.(png|jpe?g|webp)$/i.test(filePath)) return;
      state.freeReferences.push(filePath);
      accepted += 1;
    });
    renderFreeImageReferences();
    saveFreeImageSettings();
    if (accepted) showToast("已添加 " + accepted + " 张 AI 生图参考素材");
    else if (state.freeReferences.length >= maxReferences) showToast("参考素材最多添加 " + maxReferences + " 张");
    else showToast("没有添加可用图片；请使用 PNG、JPG 或 WEBP 文件");
  }

  function renderFreeImageReferences() {
    el.freeImageReferenceCount.textContent = state.freeReferences.length + " 张参考";
    el.freeImageReferenceList.innerHTML = state.freeReferences.map(function (filePath, index) {
      var name = path.basename(filePath);
      return '<div class="reference-item free-reference-item" data-index="' + index + '"><img class="reference-thumb" src="' + escapeAttr(toFileUrl(filePath)) + '" alt="' + escapeAttr(name) + '" title="' + escapeAttr(name) + '"><span class="reference-name">图' + (index + 1) + ' · ' + escapeHtml(name) + '</span><div class="reference-item-actions"><button type="button" data-action="left" title="前移" aria-label="前移">‹</button><button type="button" data-action="right" title="后移" aria-label="后移">›</button><button type="button" data-action="remove" title="移除" aria-label="移除">×</button></div></div>';
    }).join("");
    if (!state.freeReferences.length) el.freeImageReferenceList.innerHTML = '<div class="empty-inline">还没有参考素材</div>';
    bindReferencePreviewFallback(el.freeImageReferenceList, state.freeReferences);
  }

  function bindReferencePreviewFallback(list, paths) {
    Array.prototype.forEach.call(list.querySelectorAll(".reference-thumb"), function (img, index) {
      var filePath = paths[index];
      img.onerror = function () {
        if (!document.contains(img)) return;
        loadResultPreview(img, filePath, document.createElement("span"), function (ok) {
          if (!ok) img.title = "图片预览不可用，请检查本地文件";
        });
      };
    });
  }

  function renderFreeImagePrompts() {
    el.freeImagePromptCards.innerHTML = state.freePrompts.map(function (item) {
      return '<div class="free-prompt-card" data-free-prompt-id="' + escapeAttr(item.id) + '"><button type="button" class="free-prompt-use' + (selectedFreePromptId === item.id ? ' active' : '') + '" title="' + escapeAttr(item.text) + '">' + escapeHtml(item.name) + '</button><button type="button" class="free-prompt-delete" aria-label="删除预设 ' + escapeAttr(item.name) + '" title="删除预设">×</button></div>';
    }).join("") || '<span class="small-note">暂无预设，点击“新建预设”保存常用描述。</span>';
  }

  function useFreePrompt(id) {
    var item = state.freePrompts.find(function (entry) { return entry.id === id; });
    if (!item) return;
    selectedFreePromptId = id;
    el.freeImagePrompt.value = item.text;
    Array.prototype.forEach.call(el.freeImagePromptCards.querySelectorAll(".free-prompt-card"), function (card) {
      card.querySelector(".free-prompt-use").classList.toggle("active", card.getAttribute("data-free-prompt-id") === id);
    });
    saveFreeImageSettings();
  }

  function editFreePrompt(id) {
    var item = state.freePrompts.find(function (entry) { return entry.id === id; });
    currentModal = { type: "free-prompt", id: id };
    el.modalTitle.textContent = item ? "编辑生图预设" : "新建生图预设";
    el.modalName.hidden = false;
    el.modalName.value = item ? item.name : "";
    el.modalText.value = item ? item.text : el.freeImagePrompt.value;
    el.toolModal.hidden = false;
    el.modalName.focus();
  }

  function saveCurrentFreePrompt() {
    var name = el.modalName.value.trim();
    var text = el.modalText.value.trim();
    if (!name || !text) return showToast("请填写预设名称和提示词");
    var index = state.freePrompts.findIndex(function (item) { return item.id === currentModal.id; });
    var before = state.freePrompts.slice(0);
    var item = { id: index >= 0 ? state.freePrompts[index].id : "free_prompt_" + Date.now(), name: name, text: text };
    if (index >= 0) state.freePrompts[index] = item; else state.freePrompts.unshift(item);
    if (!saveFreeImagePrompts()) { state.freePrompts = before; return; }
    selectedFreePromptId = item.id;
    el.freeImagePrompt.value = text;
    renderFreeImagePrompts();
    saveFreeImageSettings();
    closeModal();
    showToast("生图预设已保存");
  }

  function deleteCurrentFreePrompt(id) {
    var index = state.freePrompts.findIndex(function (item) { return item.id === id; });
    if (index < 0 || !state.freePrompts[index]) return;
    if (!window.confirm("删除当前保存的提示词？")) return;
    var before = state.freePrompts.slice(0);
    state.freePrompts.splice(index, 1);
    if (!saveFreeImagePrompts()) { state.freePrompts = before; return; }
    if (selectedFreePromptId === id) selectedFreePromptId = "";
    saveFreeImageSettings();
    renderFreeImagePrompts();
    showToast("提示词已删除");
  }

  function generateFreeImage() {
    var prompt = el.freeImagePrompt.value.trim();
    if (busyFreeImage) return;
    if (!prompt) return showToast("请先填写生图提示词");
    if (freeModelCapabilities && freeModelCapabilities.models.indexOf(el.freeImageModel.value) < 0) return showToast("当前秘钥未开放所选模型，请选择标注“已列出”的型号，或检查秘钥设置。");
    saveFreeImageSettings();
    busyFreeImage = true;
    el.generateFreeImageBtn.disabled = true;
    el.freeImageProgress.hidden = false;
    el.freeImageProgressTitle.textContent = "正在生成 AI 图片";
    el.freeImageProgressValue.textContent = "已提交";
    el.freeImageProgressBar.style.width = "5%";
    var started = Date.now();
    freeImageTimer = window.setInterval(function () {
      var seconds = Math.floor((Date.now() - started) / 1000);
      el.freeImageProgressBar.style.width = Math.min(94, 5 + seconds * 0.45) + "%";
      el.freeImageProgressValue.textContent = "生成中 · " + seconds + " 秒";
    }, 1000);
    requestBridge("generate-free-image", {
      freePrompt: prompt,
      freeRatio: el.freeImageSize.value,
      freeResolution: el.freeImageResolution.value,
      freeImageModel: el.freeImageModel.value,
      freeCount: Number(el.freeImageCount.value),
      freeReferenceImagePath: state.freeReferences[0] || "",
      freeReferenceImagePaths: state.freeReferences.slice(0),
      freeOutputPrefix: "afm_free_image"
    }, function (error, response) {
      window.clearInterval(freeImageTimer);
      freeImageTimer = null;
      busyFreeImage = false;
      el.generateFreeImageBtn.disabled = false;
      if (error || !response || !response.ok) {
        el.freeImageProgressTitle.textContent = "生成失败";
        el.freeImageProgressValue.textContent = error || (response && response.error) || "服务没有返回图片";
        el.freeImageProgressBar.style.width = "0%";
        refreshFreeImages();
        return showToast("AI 生图失败：" + (error || (response && response.error) || "未知错误"));
      }
      el.freeImageProgressTitle.textContent = "生成完成";
      el.freeImageProgressValue.textContent = response.usedReference
        ? (response.imagePaths || []).length + " 张图片已保存 · 已使用 " + (response.referenceCount || 0) + " 张参考图"
        : (response.imagePaths || []).length + " 张图片已保存 · 未使用参考图";
      el.freeImageProgressBar.style.width = "100%";
      refreshFreeImages(response.imagePath || (response.imagePaths && response.imagePaths[0]) || "");
      showServiceStatus(true, "本地服务已连接");
      if (response.providerModel) el.freeImageModelStatus.textContent = "已成功出图 · 接口模型 " + response.providerModel + "。实际尺寸以生成结果为准。";
      showToast("AI 图片生成完成");
    }, 800000, true);
  }

  function refreshFreeModels() {
    var ticket = ++modelCheckTicket;
    el.refreshFreeModelsBtn.disabled = true;
    el.freeImageModelStatus.textContent = "正在检测图片服务模型列表…";
    requestBridge("free-image-models", {}, function (error, response) {
      if (ticket !== modelCheckTicket) return;
      el.refreshFreeModelsBtn.disabled = false;
      freeModelCapabilities = !error && response && response.ok ? response : null;
      Array.prototype.forEach.call(el.freeImageModel.options, function (option) {
        var listed = freeModelCapabilities && freeModelCapabilities.models.indexOf(option.value) >= 0;
        var names = { "gpt-image-2.5-sunburst": "GPT Image 2.5 · Sunburst", "gpt-image-2.5-flare": "GPT Image 2.5 · Flare", "gemini-nano-banana-2.1": "Nano Banana 2.1", "gpt-image-2": "GPT Image 2" };
        option.textContent = (names[option.value] || option.value) + (freeModelCapabilities ? (listed ? " · 已列出" : " · 未开放") : " · 未检测");
      });
      updateFreeModelStatus();
    }, 25000, true);
  }

  function updateFreeModelStatus() {
    var listed = freeModelCapabilities && freeModelCapabilities.models.indexOf(el.freeImageModel.value) >= 0;
    var provider = freeModelCapabilities && freeModelCapabilities.resolvedModels && freeModelCapabilities.resolvedModels[el.freeImageModel.value];
    el.freeImageModelStatus.textContent = freeModelCapabilities ? (listed ? "已列出" + (provider ? " · 接口模型 " + provider : "") + "。可开始生成；分辨率为目标档位，实际尺寸以结果为准。" : "当前秘钥未开放所选型号，请选择标注“已列出”的模型，或检查秘钥设置。") : "尚未完成模型检测，请点击“检测模型”重试。";
  }

  function refreshFreeImages(preferredPath) {
    resultGalleries.free.signature = null;
    var files = [];
    try {
      files = fs.readdirSync(generatedDir).filter(function (name) { return /^afm_free_image_/i.test(name) && /\.(png|jpe?g|webp)$/i.test(name); }).map(function (name) {
        var filePath = path.join(generatedDir, name);
        var stat = fs.statSync(filePath);
        return { path: filePath, name: name, mtime: stat.mtimeMs || stat.mtime.getTime() };
      }).sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 100);
    } catch (err) { showToast("读取 AI 生图目录失败：" + err.message); }
    freeGeneratedFiles = files;
    el.freeImageSummary.textContent = files.length + " 张结果";
    el.freeImageEmpty.hidden = files.length > 0;
    if (preferredPath && files.some(function (item) { return item.path === preferredPath; })) selectedFreeImagePath = preferredPath;
    if (!files.some(function (item) { return item.path === selectedFreeImagePath; })) selectedFreeImagePath = "";
    if (!selectedFreeImagePath && files.length) selectedFreeImagePath = files[0].path;
    if (selectedFreeImagePath && files.some(function (item) { return item.path === selectedFreeImagePath; })) selectFreeImage(selectedFreeImagePath);
    else { el.freeImageResultDetail.hidden = true; selectedFreeImagePath = ""; releaseGalleryProbe(el.freeImagePreview); }
    renderResultGallery("free");
    updateFreeImageControls();
  }

  function selectFreeImage(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    selectedFreeImagePath = filePath;
    el.freeImageResultDetail.hidden = false;
    el.freeImageName.textContent = path.basename(filePath);
    loadResultPreview(el.freeImagePreview, filePath, el.freeImageDimensions);
    resultGalleries.free.page = Math.floor(freeGeneratedFiles.findIndex(function (item) { return item.path === filePath; }) / resultPageSize);
    renderResultGallery("free");
    updateFreeImageControls();
  }

  function updateFreeImageControls() {
    var hasImage = !!selectedFreeImagePath;
    [el.previewFreeImageBtn, el.deleteFreeImageBtn, el.importFreeImageBtn, el.openFreeImageBtn, el.importFreeImageProjectBtn, el.referenceFreeImageBtn].forEach(function (button) { button.disabled = !hasImage; });
  }

  function previewFreeImage() { if (!selectedFreeImagePath) return showToast("请先选择一张结果"); openImagePreview(selectedFreeImagePath); }

  function deleteFreeImage() {
    if (!selectedFreeImagePath || !isChildPath(generatedDir, selectedFreeImagePath)) return;
    if (!window.confirm("删除所选 AI 生图结果？")) return;
    try { fs.unlinkSync(selectedFreeImagePath); selectedFreeImagePath = ""; refreshFreeImages(); showToast("已删除 AI 生图结果"); } catch (err) { showToast("删除失败：" + err.message); }
  }

  function importFreeImage() {
    importResultImage(selectedFreeImagePath, true);
  }

  function bindResultGalleries() {
    ["free"].forEach(function (kind) {
      var isFree = kind === "free";
      var list = el.freeImageResultList;
      var choose = selectFreeImage;
      list.addEventListener("click", function (event) {
        var card = closestWithClass(event.target, "result-card");
        if (card) choose(card.getAttribute("data-path"));
      });
      list.addEventListener("dblclick", function (event) {
        var card = closestWithClass(event.target, "result-card");
        if (card) { choose(card.getAttribute("data-path")); openImagePreview(card.getAttribute("data-path")); }
      });
      ["Prev", "Next"].forEach(function (direction) {
        el[kind + "Gallery" + direction].addEventListener("click", function () {
          var files = freeGeneratedFiles;
          var page = resultGalleries[kind].page + (direction === "Next" ? 1 : -1);
          if (page >= 0 && page * resultPageSize < files.length) choose(files[page * resultPageSize].path);
        });
      });
      el.openFreeImageBtn.addEventListener("click", function () { openResultImage(selectedFreeImagePath); });
      el.importFreeImageProjectBtn.addEventListener("click", function () { importResultImage(selectedFreeImagePath, false); });
      el.referenceFreeImageBtn.addEventListener("click", function () { useResultAsReference("free-image-view", selectedFreeImagePath); });
    });
  }

  function renderResultGallery(kind) {
    var gallery = resultGalleries[kind];
    var files = freeGeneratedFiles;
    var selected = selectedFreeImagePath;
    var list = el.freeImageResultList;
    var pages = Math.ceil(files.length / resultPageSize);
    gallery.page = Math.max(0, Math.min(gallery.page, pages - 1));
    el[kind + "GalleryPage"].textContent = (pages ? gallery.page + 1 : 0) + " / " + pages;
    el[kind + "GalleryPrev"].disabled = gallery.page === 0;
    el[kind + "GalleryNext"].disabled = !pages || gallery.page >= pages - 1;
    var visible = files.slice(gallery.page * resultPageSize, (gallery.page + 1) * resultPageSize);
    var signature = JSON.stringify(visible.map(function (item) { return [item.path, item.mtime]; }));
    if (signature !== gallery.signature) {
      gallery.signature = signature;
      gallery.ticket++;
      if (gallery.probe) releaseGalleryProbe(gallery.probe);
      list.innerHTML = visible.map(function (item, index) {
        return '<button type="button" class="result-card" data-path="' + escapeAttr(item.path) + '" title="' + escapeAttr(item.name) + '" aria-label="选择 ' + escapeAttr(item.name) + '"><span class="result-card-picture"><img alt="' + escapeAttr(item.name) + '" hidden><span class="result-card-status">加载中</span><span class="result-card-number">' + (gallery.page * resultPageSize + index + 1) + '</span><span class="result-card-check" aria-hidden="true">✓</span></span><span class="result-card-name">' + escapeHtml(item.name) + '</span></button>';
      }).join("");
      // Decode only one full-size image at a time, retain small canvas thumbnails.
      var ticket = gallery.ticket;
      var index = 0;
      function next() {
        if (ticket !== gallery.ticket || index >= visible.length) return;
        var item = visible[index];
        var card = list.children[index++];
        var probe = document.createElement("img");
        gallery.probe = probe;
        loadResultPreview(probe, item.path, document.createElement("span"), function (ok) {
          if (ticket !== gallery.ticket) return;
          try {
            if (!ok) throw new Error("decode");
            var canvas = document.createElement("canvas");
            var scale = Math.min(1, 240 / probe.naturalWidth, 160 / probe.naturalHeight);
            canvas.width = Math.max(1, Math.round(probe.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(probe.naturalHeight * scale));
            canvas.getContext("2d").drawImage(probe, 0, 0, canvas.width, canvas.height);
            card.querySelector("img").src = canvas.toDataURL("image/png");
            card.querySelector("img").hidden = false;
            card.querySelector(".result-card-status").hidden = true;
          } catch (error) { card.querySelector(".result-card-status").textContent = "点击查看 / 重试"; }
          releaseGalleryProbe(probe);
          gallery.probe = null;
          window.setTimeout(next, 0);
        }, true);
      }
      next();
    }
    Array.prototype.forEach.call(list.children, function (card) {
      var active = card.getAttribute("data-path") === selected;
      card.classList.toggle("active", active);
      card.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function releaseGalleryProbe(img) {
    img._previewTicket = (img._previewTicket || 0) + 1;
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
  }

  function importResultImage(filePath, asLayer) {
    if (!filePath || !fs.existsSync(filePath)) return showToast("图片不存在，请刷新结果后重试");
    evalAe("afm_importFiles(" + JSON.stringify(JSON.stringify({ paths: [filePath], asLayer: asLayer })) + ")", function (error, result) { showToast(error || result || "导入完成"); });
  }

  function openResultImage(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return showToast("图片不存在，请刷新结果后重试");
    try {
      if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        var result = window.cep.util.openURLInDefaultBrowser(toFileUrl(filePath));
        if (result && result.err) throw new Error("系统未能打开图片");
      } else if (process.platform === "win32") {
        // Explorer uses the default image application; arguments never enter a shell.
        childProcess.execFile("explorer.exe", [filePath], function (error) { if (error) showToast("打开失败，可使用预览或打开目录"); });
      } else childProcess.execFile("open", [filePath], function (error) { if (error) showToast("打开失败，可使用预览或打开目录"); });
    } catch (error) { showToast("打开失败，可使用预览或打开目录"); }
  }

  function useResultAsReference(view, filePath) {
    if (!filePath || !fs.existsSync(filePath)) return showToast("图片不存在，请刷新结果后重试");
    var refs = referencePaths(view);
    var copyPath = path.join(referenceDir, "result-" + path.basename(filePath));
    if (refs.indexOf(filePath) >= 0 || refs.indexOf(copyPath) >= 0) return showToast("这张图片已在当前页参考图中");
    if (refs.length >= maxReferences) return showToast("参考图已满 8 张，请先移除再添加");
    var previous = refs.slice(0);
    var created = false;
    try {
      if (!fs.existsSync(copyPath)) { fs.copyFileSync(filePath, copyPath); created = true; }
      refs.push(copyPath);
      var saved = saveFreeImageSettings();
      if (!saved) throw new Error("无法保存参考图设置，请检查目录写入权限");
    } catch (error) {
      state.freeReferences = previous; state.freeImageSettings.referencePaths = previous;
      if (created) { try { fs.unlinkSync(copyPath); } catch (ignore) {} }
      return showToast("添加参考图失败：" + error.message);
    }
    renderFreeImageReferences();
    showToast("已添加到当前页参考图；删除生成结果不会删除此参考副本");
  }

  function requestBridge(action, payload, callback, timeoutMs, autoStart) {
    var requestPath;
    var responsePath;
    var completed = false;
    var startTimer = null;
    var interval = null;
    var startedAt = Date.now();
    var requestId = "afm_tool_" + startedAt + "_" + Math.floor(Math.random() * 1000000);
    payload = payload || {};
    payload.action = action;
    try {
      ensureDataFolders();
      requestPath = path.join(requestDir, requestId + ".request.json");
      responsePath = path.join(requestDir, requestId + ".response.json");
      var tempPath = path.join(requestDir, requestId + ".request.tmp");
      fs.writeFileSync(tempPath, JSON.stringify(payload), "utf8");
      fs.renameSync(tempPath, requestPath);
    } catch (err) {
      callback(err.message);
      return;
    }
    function finish(error, response) {
      if (completed) return;
      completed = true;
      window.clearInterval(interval);
      window.clearTimeout(startTimer);
      try { if (fs.existsSync(responsePath)) fs.unlinkSync(responsePath); } catch (ignoreResponse) {}
      callback(error || null, response || null);
    }
    interval = window.setInterval(function () {
      if (fs.existsSync(responsePath)) {
        try {
          var response = JSON.parse(fs.readFileSync(responsePath, "utf8").replace(/^\uFEFF/, ""));
          finish(null, response);
        } catch (err) { finish(err.message); }
      } else if (Date.now() - startedAt > (timeoutMs || 15000)) {
        finish("等待本地 AI 服务响应超时。请检查服务配置和网络连接。");
      }
    }, 350);
    if (autoStart) {
      startTimer = window.setTimeout(function () {
        if (!completed) startLocalService();
      }, action === "health" ? 1300 : 3500);
    }
  }

  function startLocalService() {
    if (serviceStarted || !fs.existsSync(bundledService)) return;
    serviceStarted = true;
    var launcherNode = path.join(appData, "AFMAnimeRuntime", "node", "node.exe");
    var executable = fs.existsSync(launcherNode) ? launcherNode : "node";
    var env = {};
    Object.keys(process.env).forEach(function (key) { env[key] = process.env[key]; });
    env.AE3_AI_SERVICE_DIR = dataDir;
    try {
      var child = childProcess.spawn(executable, [bundledService], {
        cwd: path.dirname(bundledService),
        env: env,
        detached: true,
        windowsHide: true,
        stdio: "ignore"
      });
      child.unref();
      showToast("正在启动本地 AI 服务…");
    } catch (err) {
      showServiceStatus(false, "服务启动失败");
      showToast("无法启动本地服务：" + err.message);
    }
  }

  function checkService(showInitial) {
    showServiceStatus(false, "正在检查本地服务", true);
    requestBridge("health", {}, function (error, response) {
      if (error || !response || !response.ok) {
        showServiceStatus(false, "本地服务不可用");
        if (!showInitial) showToast("请打开秘钥设置检查配置与运行环境");
        return;
      }
      showServiceStatus(true, "本地服务已连接");
      el.globalStatus.textContent = "本机独立保存 · v9.3.2 个人测试版";
    }, 12000, true);
  }

  function showServiceStatus(online, text, checking, warning) {
    el.serviceStatus.className = "service-status " + (checking ? "checking" : (warning ? "warning" : (online ? "online" : "offline")));
    el.serviceStatus.lastElementChild.textContent = text;
  }

  function evalAe(script, callback) {
    if (!cs) return callback("AE Bridge 不可用");
    try {
      cs.evalScript(script, function (result) {
        if (result === "EvalScript error.") callback("AE 宿主脚本执行失败");
        else callback(null, result);
      });
    } catch (err) { callback(err.message); }
  }

  function revealFolder(folder) {
    try {
      var executable = process.platform === "win32" ? "explorer.exe" : "open";
      childProcess.execFile(executable, [folder], function () {});
    } catch (err) { showToast("无法打开目录：" + err.message); }
  }

  function bindModalEvents() {
    el.closeModalBtn.addEventListener("click", closeModal);
    el.cancelModalBtn.addEventListener("click", closeModal);
    el.toolModal.addEventListener("click", function (event) { if (event.target === el.toolModal) closeModal(); });
    el.saveModalBtn.addEventListener("click", saveModal);
    el.closePreviewBtn.addEventListener("click", closeImagePreview);
    el.previewModal.addEventListener("click", function (event) {
      if (event.target === el.previewModal) closeImagePreview();
    });
    document.addEventListener("keydown", function (event) {
      if (el.previewModal.hidden) return;
      if (event.key === "Escape") { event.preventDefault(); closeImagePreview(); }
      else if (event.key === "Tab") { event.preventDefault(); el.closePreviewBtn.focus(); }
    });
  }

  function saveModal() { if (currentModal) saveCurrentFreePrompt(); }

  function closeModal() { currentModal = null; el.toolModal.hidden = true; }

  function showToast(message) {
    el.toast.textContent = String(message || "");
    el.toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.toast.classList.remove("visible"); }, 3000);
  }

  function toFileUrl(filePath) {
    var normalized = String(filePath).replace(/\\/g, "/");
    var encoded = normalized.split("/").map(function (part, index) {
      return index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part);
    }).join("/");
    return (normalized.indexOf("//") === 0 ? "file:" : normalized.charAt(0) === "/" ? "file://" : "file:///") + encoded;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

  function swap(list, first, second) { var item = list[first]; list[first] = list[second]; list[second] = item; }

  function closestWithClass(node, className) {
    while (node && node !== document) {
      if (node.classList && node.classList.contains(className)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function closestWithAttribute(node, attribute) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute(attribute) !== null) return node;
      node = node.parentNode;
    }
    return null;
  }

  function isChildPath(parent, child) {
    var relative = path.relative(path.resolve(parent), path.resolve(child));
    return !!relative && relative.indexOf("..") !== 0 && !path.isAbsolute(relative);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());
