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
  var expressionsFile = path.join(dataDir, "AE_ScriptManager_expressions.json");
  var defaultsFile = path.join(extensionRoot, "data", "ai-tools-default-expressions.json");
  var selectedExpressionId = "", expressionFilter = "all", busyExpression = false, expressionTimer = null;
  var state = { expressions: [], aiVariants: [] };
  var savedLibrary = [];
  function init() {
    cacheElements(); ensureDataFolders(); loadSharedData();
    el.checkServiceBtn.addEventListener("click", function () { checkService(false); });
    window.addEventListener("afm-ai-config-saved", function () { serviceStarted = false; el.globalStatus.textContent = "AI 配置已保存，下次请求使用新配置";  });
    window.addEventListener("afm-ai-config-cleared", function () { serviceStarted = false; el.globalStatus.textContent = "本机秘钥已清空，请重新填写";  });
    bindExpressionEvents(); renderExpressions(); if (state.expressions.length) selectExpression(state.expressions[0].id);
    renderExpressionAiVariants();
    checkService(true);
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
    state.expressions = readJson(expressionsFile, null);
    if (!Array.isArray(state.expressions)) {
      state.expressions = readJson(defaultsFile, []);
      writeJson(expressionsFile, state.expressions);
    }
    state.expressions = state.expressions.map(normalizeExpression).filter(Boolean);
    savedLibrary = JSON.parse(JSON.stringify(state.expressions));
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

  function normalizeExpression(item, index) {
    if (!item || typeof item !== "object") return null;
    var allowed = ["transform.opacity", "transform.scale", "transform.rotation", "transform.position", "transform.anchorPoint", "action"];
    if (allowed.indexOf(item.type) === -1) return null;
    return {
      id: String(item.id || ("expression_" + Date.now() + "_" + index)),
      name: String(item.name || "未命名表达式"),
      type: item.type,
      code: String(item.code || ""),
      remark: String(item.remark || "")
    };
  }

  function saveExpressions() {
    try {
      writeJson(expressionsFile, state.expressions);
      savedLibrary = JSON.parse(JSON.stringify(state.expressions));
      renderExpressions();
      setExpressionStatus("已保存到本机 AEFileManager-Anime 表达式库");
      return true;
    } catch (err) {
      state.expressions = JSON.parse(JSON.stringify(savedLibrary));
      renderExpressions();
      setExpressionStatus("保存失败：" + err.message, true);
      return false;
    }
  }

  function bindExpressionEvents() {
    el.expressionAiShortcutBtn.addEventListener("click", function () {
      el.expressionAiPrompt.focus();
      el.expressionAiPrompt.scrollIntoView({ block: "nearest" });
    });
    el.expressionAiGenerateBtn.addEventListener("click", function () {
      generateExpression();
    });
    el.extendCurrentExpressionBtn.addEventListener("click", generateCurrentExpressionVariants);
    el.expressionAiVariants.addEventListener("input", function (event) {
      var card = closestWithClass(event.target, "expression-ai-variant");
      if (!card) return;
      syncVariant(Number(card.getAttribute("data-variant-index")));
    });
    el.expressionAiVariants.addEventListener("click", function (event) {
      var button = closestWithClass(event.target, "variant-action");
      var card = closestWithClass(event.target, "expression-ai-variant");
      if (!button || !card || busyExpression) return;
      var index = Number(card.getAttribute("data-variant-index"));
      var action = button.getAttribute("data-action");
      if (action === "test") testVariant(index);
      else if (action === "save") saveVariant(index);
      else if (action === "copy") copyVariant(index);
    });
    el.expressionSizeSlider.addEventListener("input", function () { applyExpressionSize(el.expressionSizeSlider.value, true); });
    el.expressionSearch.addEventListener("input", renderExpressions);
    el.expressionCode.addEventListener("input", updateExpressionExtendButton);
    el.expressionFilters.addEventListener("click", function (event) {
      var button = closestWithClass(event.target, "filter-button");
      if (!button) return;
      expressionFilter = button.getAttribute("data-filter");
      renderExpressionFilters();
      renderExpressions();
    });
    el.expressionList.addEventListener("click", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (!item) return;
      var id = item.getAttribute("data-id");
      if (closestWithClass(event.target, "expression-delete-action")) {
        selectExpression(id);
        deleteExpression();
      } else if (closestWithClass(event.target, "expression-apply-action")) {
        selectExpression(id);
        applyCurrentExpression();
      } else if (closestWithClass(event.target, "expression-edit-action")) {
        selectExpression(id);
        el.expressionLibraryEditor.open = true;
        el.expressionName.focus();
        setExpressionStatus("已展开编辑器，修改后点击“保存到表达式库”。", false);
      } else {
        selectExpression(id);
      }
    });
    el.expressionList.addEventListener("dragstart", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (!item || closestWithClass(event.target, "expression-item-actions") || closestWithClass(event.target, "expression-delete-action")) {
        event.preventDefault();
        return;
      }
      var id = item.getAttribute("data-id");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
      item.classList.add("dragging");
    });
    el.expressionList.addEventListener("dragover", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (!item || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      Array.prototype.forEach.call(el.expressionList.querySelectorAll(".expression-item.drag-over"), function (entry) {
        entry.classList.remove("drag-over");
      });
      item.classList.add("drag-over");
    });
    el.expressionList.addEventListener("dragleave", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (item && (!event.relatedTarget || !item.contains(event.relatedTarget))) item.classList.remove("drag-over");
    });
    el.expressionList.addEventListener("drop", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (!item) return;
      event.preventDefault();
      var sourceId = event.dataTransfer && event.dataTransfer.getData("text/plain");
      var targetId = item.getAttribute("data-id");
      var insertAfter = event.clientY > item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
      reorderExpression(sourceId, targetId, insertAfter);
      item.classList.remove("drag-over");
    });
    el.expressionList.addEventListener("dragend", function () {
      Array.prototype.forEach.call(el.expressionList.querySelectorAll(".expression-item.dragging, .expression-item.drag-over"), function (item) {
        item.classList.remove("dragging", "drag-over");
      });
    });
    el.expressionList.addEventListener("dblclick", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (!item || closestWithClass(event.target, "expression-item-actions")) return;
      selectExpression(item.getAttribute("data-id"));
      applyCurrentExpression();
    });
    el.expressionList.addEventListener("contextmenu", function (event) {
      var item = closestWithClass(event.target, "expression-item");
      if (!item) return;
      event.preventDefault();
      selectExpression(item.getAttribute("data-id"));
      el.expressionLibraryEditor.open = true;
      el.expressionName.focus();
      setExpressionStatus("已展开编辑器，修改后点击“保存到表达式库”。", false);
    });
    el.newExpressionBtn.addEventListener("click", function () {
      selectedExpressionId = "";
      fillExpressionEditor({ id: "", name: "新表达式", type: "transform.opacity", code: "", remark: "" });
      el.extendCurrentExpressionBtn.disabled = true;
      el.expressionAiStatus.textContent = "填写描述后生成，结果在下方三个窗口分别编辑和测试。";
      renderExpressions();
      el.expressionLibraryEditor.open = true;
      el.expressionName.focus();
    });
    el.saveExpressionBtn.addEventListener("click", saveCurrentExpression);
    el.applyExpressionBtn.addEventListener("click", applyCurrentExpression);
    el.duplicateExpressionBtn.addEventListener("click", duplicateExpression);
    el.moveExpressionUpBtn.addEventListener("click", function () { moveExpression(-1); });
    el.moveExpressionDownBtn.addEventListener("click", function () { moveExpression(1); });
    el.deleteExpressionBtn.addEventListener("click", deleteExpression);
    el.importExpressionsBtn.addEventListener("click", function () { el.expressionPicker.click(); });
    el.expressionPicker.addEventListener("change", importExpressions);
    el.exportExpressionsBtn.addEventListener("click", exportExpressions);
    loadExpressionSize();
    renderExpressionFilters();
  }

  function loadExpressionSize() {
    var value = 112;
    try { value = Number(window.localStorage.getItem("afm-expression-button-size")) || value; } catch (ignore) {}
    applyExpressionSize(value, false);
  }

  function applyExpressionSize(value, persist) {
    value = Math.max(80, Math.min(190, Number(value) || 112));
    document.documentElement.style.setProperty("--expression-button-size", value + "px");
    el.expressionSizeSlider.value = String(value);
    el.expressionSizeValue.textContent = value + "px";
    if (persist) {
      try { window.localStorage.setItem("afm-expression-button-size", String(value)); } catch (ignore) {}
    }
  }

  function renderExpressionFilters() {
    var filters = [
      ["all", "全部"], ["transform.opacity", "不透明度"], ["transform.scale", "缩放"], ["transform.rotation", "旋转"], ["transform.position", "位置"], ["transform.anchorPoint", "锚点"], ["action", "动作"]
    ];
    el.expressionFilters.innerHTML = filters.map(function (filter) {
      return '<button type="button" class="filter-button' + (expressionFilter === filter[0] ? " active" : "") + '" data-filter="' + filter[0] + '">' + filter[1] + '</button>';
    }).join("");
  }

  function renderExpressions() {
    var query = el.expressionSearch.value.trim().toLowerCase();
    var items = state.expressions.map(function (item, index) { return { item: item, index: index }; }).filter(function (row) {
      var item = row.item;
      var searchable = (item.name + " " + item.type + " " + item.remark).toLowerCase();
      return (expressionFilter === "all" || item.type === expressionFilter) && (!query || searchable.indexOf(query) !== -1);
    });
    el.expressionList.innerHTML = items.map(function (row) {
      return '<div class="expression-item' + (row.item.id === selectedExpressionId ? " active" : "") + '" data-id="' + escapeAttr(row.item.id) + '" tabindex="0" draggable="true" role="group"><div class="expression-item-main"><span><strong>' + escapeHtml(row.item.name) + '</strong><small>' + escapeHtml(row.item.remark || row.item.type) + '</small></span><span class="expression-kind">' + escapeHtml(typeName(row.item.type)) + '</span><button type="button" class="expression-delete-action" data-expression-action="delete" title="删除表达式" aria-label="删除表达式">×</button></div><div class="expression-item-actions"><button type="button" class="expression-apply-action" data-expression-action="apply">应用</button><button type="button" class="expression-edit-action" data-expression-action="edit">修改</button></div></div>';
    }).join("");
    if (!items.length) el.expressionList.innerHTML = '<div class="empty-inline">没有匹配的表达式</div>';
    el.expressionCount.textContent = items.length + " / " + state.expressions.length + " 条";
    el.saveExpressionBtn.disabled = false;
    Array.prototype.forEach.call([el.applyExpressionBtn, el.duplicateExpressionBtn, el.moveExpressionUpBtn, el.moveExpressionDownBtn, el.deleteExpressionBtn], function (button) {
      button.disabled = !selectedExpressionId;
    });
    updateExpressionExtendButton();
  }

  function updateExpressionExtendButton() {
    if (!el.extendCurrentExpressionBtn) return;
    el.extendCurrentExpressionBtn.disabled = busyExpression || !String(el.expressionCode.value || "").trim();
  }

  function selectExpression(id) {
    var item = state.expressions.filter(function (entry) { return entry.id === id; })[0];
    if (!item) return;
    selectedExpressionId = id;
    fillExpressionEditor(item);
    renderExpressions();
  }

  function fillExpressionEditor(item) {
    el.expressionEditorTitle.textContent = item.name || "新表达式";
    el.expressionName.value = item.name || "";
    el.expressionType.value = item.type || "transform.opacity";
    el.expressionRemark.value = item.remark || "";
    el.expressionCode.value = item.code || "";
    el.expressionTypeBadge.textContent = typeName(item.type);
    setExpressionStatus(item.id ? "双击列表，或点击“应用到选中图层”。" : "填写名称与代码后保存。", false);
  }

  function saveCurrentExpression() {
    var item = normalizeExpression({
      id: selectedExpressionId || ("user_" + Date.now() + "_" + Math.floor(Math.random() * 100000)),
      name: el.expressionName.value.trim(), type: el.expressionType.value,
      remark: el.expressionRemark.value.trim(), code: el.expressionCode.value
    }, state.expressions.length);
    if (!item || !item.name) return setExpressionStatus("请填写表达式名称。", true);
    if (item.type !== "action" && !item.code.trim()) return setExpressionStatus("表达式代码不能为空。", true);
    var index = state.expressions.findIndex(function (entry) { return entry.id === selectedExpressionId; });
    if (index < 0) state.expressions.push(item);
    else state.expressions[index] = item;
    var previousId = selectedExpressionId;
    selectedExpressionId = item.id;
    if (!saveExpressions()) { selectedExpressionId = previousId; renderExpressions(); return false; }
    fillExpressionEditor(item);
    setExpressionStatus("已保存到顶部表达式库。", false);
    return true;
  }

  function applyCurrentExpression() {
    var item = { id: selectedExpressionId, name: el.expressionName.value.trim(), type: el.expressionType.value, remark: el.expressionRemark.value.trim(), code: el.expressionCode.value };
    applyExpressionItem(item, function (message, error) { setExpressionStatus(message, error); });
  }

  function applyExpressionItem(item, callback) {
    if (item.type !== "action" && !String(item.code || "").trim()) return callback("表达式代码不能为空。", true);
    var payload = { id: item.id || "", name: item.name, type: item.type, remark: item.remark || "", code: item.code, expressionCode: item.code };
    evalAe("afm_applyExpressionItem(" + JSON.stringify(JSON.stringify(payload)) + ")", function (error, result) {
      var response = parseEvalJson(result);
      if (error || !response || !response.ok) callback(error || (response && response.error) || result || "应用失败", true);
      else callback(response.message || "已应用到 " + response.applied + " 个图层，可在 AE 中预览；撤销可恢复上一步。", false);
    });
  }

  function duplicateExpression() {
    var item = state.expressions.filter(function (entry) { return entry.id === selectedExpressionId; })[0];
    if (!item) return;
    var copy = { id: "user_" + Date.now(), name: item.name + " 副本", type: item.type, code: item.code, remark: item.remark };
    state.expressions.splice(state.expressions.indexOf(item) + 1, 0, copy);
    selectedExpressionId = copy.id;
    if (!saveExpressions()) return;
    fillExpressionEditor(copy);
  }

  function reorderExpression(sourceId, targetId, insertAfter) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    var sourceIndex = state.expressions.findIndex(function (item) { return item.id === sourceId; });
    var targetIndex = state.expressions.findIndex(function (item) { return item.id === targetId; });
    if (sourceIndex < 0 || targetIndex < 0) return;
    var moved = state.expressions.splice(sourceIndex, 1)[0];
    targetIndex = state.expressions.findIndex(function (item) { return item.id === targetId; });
    if (targetIndex < 0) return;
    state.expressions.splice(targetIndex + (insertAfter ? 1 : 0), 0, moved);
    if (saveExpressions()) setExpressionStatus("表达式顺序已保存。", false);
  }

  function moveExpression(delta) {
    var index = state.expressions.findIndex(function (item) { return item.id === selectedExpressionId; });
    var next = index + delta;
    if (index < 0 || next < 0 || next >= state.expressions.length) return;
    var value = state.expressions.splice(index, 1)[0];
    state.expressions.splice(next, 0, value);
    saveExpressions();
  }

  function deleteExpression() {
    var index = state.expressions.findIndex(function (item) { return item.id === selectedExpressionId; });
    if (index < 0) return;
    if (!window.confirm("删除表达式“" + state.expressions[index].name + "”？")) return;
    state.expressions.splice(index, 1);
    selectedExpressionId = "";
    fillExpressionEditor({ name: "选择一条表达式", type: "transform.opacity", code: "", remark: "" });
    saveExpressions();
  }

  function importExpressions() {
    var file = el.expressionPicker.files && el.expressionPicker.files[0];
    if (!file || !file.path) return showToast("CEP 无法读取所选文件路径");
    try {
      var imported = JSON.parse(fs.readFileSync(file.path, "utf8").replace(/^\uFEFF/, ""));
      if (!Array.isArray(imported)) throw new Error("JSON 顶层必须是表达式数组");
      var existing = {};
      state.expressions.forEach(function (item) { existing[item.id] = true; });
      var added = [];
      imported.forEach(function (raw, index) {
        var item = normalizeExpression(raw, index);
        if (!item) return;
        if (existing[item.id]) item.id = "import_" + Date.now() + "_" + index;
        existing[item.id] = true;
        added.push(item);
      });
      if (!added.length) throw new Error("没有可导入的有效表达式");
      state.expressions = state.expressions.concat(added);
      if (saveExpressions()) showToast("已导入 " + added.length + " 条表达式");
    } catch (err) { showToast("导入失败：" + err.message); }
    el.expressionPicker.value = "";
  }

  function exportExpressions() {
    evalAe("afm_chooseExpressionExportPath()", function (error, result) {
      var response = parseEvalJson(result);
      if (error || !response || !response.ok) {
        if (response && response.cancelled) return;
        return showToast(error || (response && response.error) || "无法选择导出路径");
      }
      try {
        fs.writeFileSync(response.path, JSON.stringify(state.expressions, null, 2), "utf8");
        showToast("已导出 " + state.expressions.length + " 条表达式");
      } catch (err) { showToast("导出失败：" + err.message); }
    });
  }

  function setExpressionStatus(message, isError) {
    el.expressionStatus.textContent = message;
    el.expressionStatus.style.color = isError ? "#e9a294" : "";
  }

  function generateExpression(options) {
    if (busyExpression) return;
    options = options || {};
    var prompt = options.prompt || el.expressionAiPrompt.value.trim();
    if (!prompt) return showToast("请先填写 AI 表达式需求");
    var targetType = options.targetType || el.expressionAiType.value;
    state.aiVariants.forEach(function (slot, index) { syncVariant(index); });
    if (state.aiVariants.some(function (slot) { return slot.item && slot.dirty; }) && !window.confirm("生成新方案会替换当前未保存的结果，是否继续？")) return;
    busyExpression = true;
    setExpressionAIActions(true);
    el.expressionAiStatus.textContent = "正在生成 3 个不同方案…";
    var seconds = 0;
    expressionTimer = window.setInterval(function () {
      seconds += 1;
      el.expressionAiStatus.textContent = "正在生成 3 个方案 · " + seconds + " 秒";
    }, 1000);
    requestBridge("generate-expression", {
      prompt: prompt,
      targetType: targetType,
      targetLabel: typeName(targetType),
      model: el.expressionAiModel.value || "",
      variantCount: 3
    }, function (error, response) {
      window.clearInterval(expressionTimer);
      expressionTimer = null;
      busyExpression = false;
      if (error || !response || !response.ok) {
        setExpressionAIActions(false);
        el.expressionAiStatus.textContent = "生成失败，已有结果保留：" + formatAIError(error || (response && response.error) || "无有效结果");
        return;
      }
      var raw = Array.isArray(response.variants) ? response.variants : (response.code ? [response] : []);
      var slots = [0, 1, 2].map(function (index) {
        var value = raw[index];
        var valid = value && value.ok !== false && typeof value.code === "string" && value.code.trim();
        return valid ? { item: makeAIExpression(value, "方案 " + (index + 1), targetType), dirty: true, savedId: "", message: "可编辑代码后测试，满意后保存。" } : { item: null, message: value && value.error || "此方案未返回有效代码，请调整描述后重新生成。", error: true };
      });
      var validCount = slots.filter(function (slot) { return slot.item; }).length;
      if (!validCount) {
        setExpressionAIActions(false);
        el.expressionAiStatus.textContent = "没有返回有效表达式，已有结果保留。请调整描述后重试。";
        return;
      }
      state.aiVariants = slots;
      setExpressionAIActions(false);
      el.expressionAiStatus.textContent = validCount === 3 ? "3 个表达式已生成 · 分别编辑、测试，保存喜欢的方案。" : "已生成 " + validCount + " 个有效方案，其余窗口已标明原因；未自动重试。";
      showServiceStatus(true, "本地服务已连接");
    }, 110000, true);
  }

  function makeAIExpression(response, fallbackName, targetType) {
    return {
      id: "ai_" + Date.now() + "_" + Math.floor(Math.random() * 1000000),
      name: String(response.name || fallbackName), type: targetType,
      code: String(response.code || ""), remark: String(response.remark || "AI生成"),
      explanation: String(response.explanation || ""), testTips: String(response.testTips || "")
    };
  }

  function setExpressionAIActions(busy) {
    el.expressionAiGenerateBtn.disabled = busy;
    el.expressionAiGenerateBtn.textContent = busy ? "正在生成 3 个方案…" : "✦ 生成 3 个表达式";
    el.expressionAiPrompt.disabled = busy;
    el.expressionAiType.disabled = busy;
    el.expressionAiModel.disabled = busy;
    updateExpressionExtendButton();
    renderExpressionAiVariants();
  }

  function generateCurrentExpressionVariants() {
    var code = String(el.expressionCode.value || "").trim();
    if (!code) return showToast("请先选择或填写一条表达式");
    if (el.expressionType.value === "action") return showToast("请选择变换属性表达式，动作脚本不能作为 AI 表达式生成。");
    var prompt = ["请基于以下表达式生成三个不同实现的方案，保持目标属性及原始动效方向一致。", "名称：" + el.expressionName.value.trim(), "备注：" + el.expressionRemark.value.trim(), "当前代码：\n" + code].join("\n");
    el.expressionAiPrompt.value = prompt.slice(0, 2000);
    el.expressionAiType.value = el.expressionType.value;
    generateExpression({ prompt: prompt, targetType: el.expressionType.value });
    el.expressionAiPrompt.scrollIntoView({ block: "nearest" });
  }

  function variantSnapshot(item) {
    return JSON.stringify([item.name, item.code, item.remark]);
  }

  function syncVariant(index) {
    var slot = state.aiVariants[index];
    var card = el.expressionAiVariants.querySelector('[data-variant-index="' + index + '"]');
    if (!slot || !slot.item || !card) return slot;
    ["name", "code", "remark"].forEach(function (field) {
      var input = card.querySelector('[data-ai-field="' + field + '"]');
      if (input) slot.item[field] = input.value;
    });
    slot.dirty = variantSnapshot(slot.item) !== slot.savedSnapshot;
    var save = card.querySelector('[data-action="save"]');
    if (save) save.textContent = slot.savedId ? (slot.dirty ? "更新表达式库" : "已保存 · 再次保存") : "保存到表达式库";
    return slot;
  }

  function renderExpressionAiVariants() {
    if (!state.aiVariants.length) state.aiVariants = [0, 1, 2].map(function () { return { item: null }; });
    el.expressionAiVariants.setAttribute("aria-busy", String(busyExpression));
    el.expressionAiVariants.innerHTML = state.aiVariants.map(function (slot, index) {
      var item = slot.item || {};
      var disabled = !slot.item || busyExpression ? " disabled" : "";
      var info = [item.explanation, item.testTips ? "测试建议：" + item.testTips : ""].filter(Boolean).join("\n");
      var message = busyExpression ? "正在生成新方案，原有结果暂时保留…" : (slot.message || "等待生成 · 这里将显示独立表达式");
      return '<article class="expression-ai-variant' + (slot.item ? ' has-result' : '') + '" data-variant-index="' + index + '">' +
        '<div class="variant-heading"><span class="variant-number">0' + (index + 1) + '</span><h3>方案 ' + (index + 1) + '</h3><span class="type-badge">' + escapeHtml(item.type ? typeName(item.type) : "等待生成") + '</span></div>' +
        '<label class="variant-name-label"><span>表达式名称</span><input data-ai-field="name" aria-label="方案 ' + (index + 1) + ' 名称" maxlength="80" value="' + escapeAttr(item.name || '') + '" placeholder="生成后可以重命名"' + disabled + ' /></label>' +
        '<label class="variant-code-label"><span>表达式代码</span><textarea class="expression-variant-code" data-ai-field="code" aria-label="方案 ' + (index + 1) + ' 代码" spellcheck="false" placeholder="点击上方生成按钮，获得可编辑代码"' + disabled + '>' + escapeHtml(item.code || '') + '</textarea></label>' +
        '<label class="variant-remark-label"><span>备注</span><input data-ai-field="remark" aria-label="方案 ' + (index + 1) + ' 备注" maxlength="160" value="' + escapeAttr(item.remark || '') + '" placeholder="保存到库时的说明"' + disabled + ' /></label>' +
        (info ? '<details class="variant-help"><summary>原理与测试建议</summary><p>' + escapeHtml(info) + '</p></details>' : '<div class="variant-help-placeholder"></div>') +
        '<div class="variant-actions"><button class="button secondary small variant-action" type="button" data-action="copy"' + disabled + '>复制</button><button class="button secondary small variant-action" type="button" data-action="test"' + (slot.testing ? ' disabled' : disabled) + '>测试 / 应用</button><button class="button primary small variant-action" type="button" data-action="save"' + disabled + '>' + (slot.savedId ? '更新表达式库' : '保存到表达式库') + '</button></div>' +
        '<div class="variant-status' + (slot.error ? ' is-error' : '') + '" role="status">' + escapeHtml(message) + '</div></article>';
    }).join("");
  }

  function testVariant(index) {
    var slot = syncVariant(index);
    if (!slot || !slot.item || slot.testing) return;
    var item = JSON.parse(JSON.stringify(slot.item));
    slot.testing = true;
    slot.message = "正在应用到 AE 选中图层…";
    renderExpressionAiVariants();
    applyExpressionItem(item, function (message, error) {
      slot.testing = false;
      if (state.aiVariants[index] !== slot) return;
      slot.message = message;
      slot.error = !!error;
      renderExpressionAiVariants();
    });
  }

  function saveVariant(index) {
    var slot = syncVariant(index);
    if (!slot || !slot.item) return;
    var item = normalizeExpression(slot.item, index);
    if (!slot.item.name.trim() || !item.code.trim()) {
      slot.message = "请填写名称和表达式代码后保存。";
      slot.error = true;
      return renderExpressionAiVariants();
    }
    item.id = slot.savedId || item.id;
    var previous = state.expressions.findIndex(function (entry) { return entry.id === item.id; });
    if (previous >= 0) state.expressions[previous] = item;
    else state.expressions.push(item);
    if (!saveExpressions()) {
      slot.message = "保存失败，表达式库未更改。请检查目录写入权限后重试。";
      slot.error = true;
      return renderExpressionAiVariants();
    }
    slot.savedId = item.id;
    slot.savedSnapshot = variantSnapshot(slot.item);
    slot.dirty = false;
    slot.message = "已保存到上方表达式库，可直接调用。";
    slot.error = false;
    // Reveal the new item even if an earlier library filter hid it.
    expressionFilter = "all";
    el.expressionSearch.value = "";
    renderExpressionFilters();
    renderExpressions();
    renderExpressionAiVariants();
  }

  function copyVariant(index) {
    var slot = syncVariant(index);
    if (!slot || !slot.item) return;
    var area = el.expressionAiVariants.querySelector('[data-variant-index="' + index + '"] textarea');
    area.focus(); area.select();
    try { if (!document.execCommand("copy")) throw new Error("clipboard"); showToast("表达式代码已复制"); }
    catch (error) { showToast("代码已选中，请按 Ctrl+C 复制"); }
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

  function formatAIError(message) {
    var value = String(message || "");
    if (/no access to model|模型无权限|model_not_found|403/i.test(value)) return "当前 API Key 没有文本模型权限。请打开右上角“AI 设置”，填写具备对应模型权限的文本密钥，再检测服务。";
    if (/401|unauthorized|invalid.*key/i.test(value)) return "文本模型 API Key 无效或已过期，请打开右上角“AI 设置”更新密钥。";
    return value;
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

  function parseEvalJson(value) {
    try { return JSON.parse(value); } catch (err) { return null; }
  }

  function showToast(message) {
    el.toast.textContent = String(message || "");
    el.toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.toast.classList.remove("visible"); }, 3000);
  }

  function typeName(type) {
    var names = {
      "transform.opacity": "不透明度", "transform.scale": "缩放", "transform.rotation": "旋转",
      "transform.position": "位置", "transform.anchorPoint": "锚点", action: "动作"
    };
    return names[type] || "未分类";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

  function closestWithClass(node, className) {
    while (node && node !== document) {
      if (node.classList && node.classList.contains(className)) return node;
      node = node.parentNode;
    }
    return null;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());
