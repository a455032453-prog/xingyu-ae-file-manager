(function () {
  "use strict";
  var nodeRequire = window.require || (window.parent && window.parent.require);
  if (!nodeRequire) return;
  var fs, path, store, file, root, dataDir;
  try {
    fs = nodeRequire("fs"); path = nodeRequire("path");
    root = path.dirname(decodeURI(String(location.pathname || "")).replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, path.sep));
    store = nodeRequire(path.join(root, "ai-service", "config-store.js"));
    if (!store || !store.read) return;
    dataDir = path.join(process.env.APPDATA || path.join(nodeRequire("os").homedir(), "AppData", "Roaming"), "AEFileManager-Anime");
    file = path.join(dataDir, "ai-service-config.json");
  } catch (error) { return; }
  var overlay, controls = {}, revision = "", previousFocus, busy = false;
  var serviceTimer = null, startTimer = null, statusRequest = null, statusResponse = null;

  function init() {
    var nav = document.querySelector(".page-tabs");
    if (!nav) return;
    var trigger = document.createElement("button");
    trigger.id = "aiSettingsBtn";
    trigger.type = "button";
    trigger.className = "afm-ai-settings-trigger";
    trigger.textContent = "✧ 秘钥设置";
    nav.appendChild(trigger);
    overlay = document.createElement("div");
    overlay.id = "aiSettingsOverlay";
    overlay.className = "afm-ai-settings-overlay";
    overlay.hidden = true;
    overlay.innerHTML = '<section class="afm-ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="aiSettingsTitle">' +
      '<header><div><small>FIRST LINK / 初次连接</small><h2 id="aiSettingsTitle">让灵感，连接星屿</h2></div><button id="aiSettingsClose" type="button" aria-label="关闭 AI 设置">×</button></header>' +
      '<div class="afm-ai-settings-body"><p>一个秘钥，同时开启 AI 表达式与 AI 生图。</p>' +
      '<a id="aiKeyApplyLink" class="anime-key-link" href="https://ai.jck123.cn/" target="_blank" rel="noopener noreferrer">还没有秘钥？前往 ai.jck123.cn 申请 ↗</a>' +
      '<div id="aiSharedFields"><label for="aiSharedKey">AI 秘钥</label><input id="aiSharedKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入同时支持图片与文本的 API Key"></div>' +
      '<p class="afm-ai-settings-note">秘钥仅按当前 Windows 用户加密保存在本机，不写入插件文件。分享插件前可清空本机秘钥；这不会撤销平台秘钥，也不会取消已发出的请求。</p>' +
      '<div id="aiSettingsStatus" class="afm-ai-settings-status" role="status" aria-live="polite"></div></div>' +
      '<footer><button id="aiSettingsClear" type="button">清空已保存秘钥</button><button id="aiSettingsSkip" type="button">暂不设置</button><button id="aiSettingsSave" type="button">确认并使用</button></footer></section>';
    document.body.appendChild(overlay);
    ["aiSettingsClear", "aiKeyApplyLink", "aiSettingsClose", "aiSharedFields", "aiSharedKey", "aiSettingsStatus", "aiSettingsSkip", "aiSettingsSave"].forEach(function (id) { controls[id] = document.getElementById(id); });
    controls.aiKeyApplyLink.addEventListener("click", function (event) {
      event.preventDefault();
      try {
        if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) window.cep.util.openURLInDefaultBrowser("https://ai.jck123.cn/");
        else nodeRequire("child_process").spawn("explorer.exe", ["https://ai.jck123.cn/"], { windowsHide: true });
      } catch (error) { message("请在浏览器打开 https://ai.jck123.cn/ 申请秘钥。"); }
    });
    controls.aiSettingsClear.addEventListener("click", eraseSavedKeys);
    trigger.addEventListener("click", function () { open(); });
    controls.aiSettingsClose.addEventListener("click", close);
    controls.aiSettingsSkip.addEventListener("click", close);
    controls.aiSettingsSave.addEventListener("click", save);
    overlay.addEventListener("click", function (event) { if (event.target === overlay) close(); });
    overlay.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        var focusable = Array.prototype.filter.call(overlay.querySelectorAll("input, button, a[href]"), function (node) { return !node.disabled && node.getClientRects().length; });
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    window.AFMAISettings = { open: open };
    // Each independent top-level page shares the same local onboarding state.
    if (window.parent !== window) return;
    var config = {}, errorMessage = "";
    try { config = store.read(file); } catch (error) { errorMessage = error.message; }
    var hasKeys = !!(config.apiKey || config.textApiKey || config.imageApiKey);
    var skipped = false;
    try { skipped = window.sessionStorage.getItem("afm-ai-setup-skipped") === "1"; } catch (ignore) {}
    if ((!hasKeys || errorMessage) && !skipped) open();
  }
  function eraseSavedKeys() {
    if (busy) return;
    stopStatusCheck();
    try {
      store.clear(file, revision);
      revision = store.readRaw(file);
      clearKeys();
      controls.aiSharedKey.placeholder = "输入同时支持图片与文本的 API Key";
      controls.aiSettingsSkip.textContent = "关闭";
      try { window.sessionStorage.removeItem("afm-ai-setup-skipped"); } catch (ignore) {}
      window.dispatchEvent(new Event("afm-ai-config-cleared"));
      message("已清空本机保存的全部 AI 秘钥。后续生成需重新填写；已发出的请求不受影响。");
      controls.aiSharedKey.focus();
    } catch (error) { message(error.message || "清空失败，请重试。"); }
  }
  function message(text) { controls.aiSettingsStatus.textContent = text; }
  function clearKeys() { ["aiSharedKey"].forEach(function (id) { controls[id].value = ""; }); }
  function open() {
    if (busy) return;
    previousFocus = document.activeElement;
    stopStatusCheck();
    var config = {}, errorMessage = "";
    try { revision = store.readRaw(file); config = store.read(file); } catch (error) { errorMessage = error.message; }
    var imageKey = config.imageApiKey || config.apiKey || "";
    var textKey = config.textApiKey || config.apiKey || "";
    clearKeys();
    controls.aiSharedKey.placeholder = imageKey && imageKey === textKey ? "已保存，留空保留原秘钥" : "输入同时支持图片与文本的 API Key";
    controls.aiSettingsSkip.textContent = imageKey || textKey ? "关闭" : "暂不设置";
    message(errorMessage || (imageKey && imageKey === textKey ? "秘钥已保存；留空可保留原秘钥。" : imageKey || textKey ? "检测到旧版独立秘钥，请输入一个共用秘钥后确认。" : "图片与文本共用一个秘钥，确认后即可使用。"));
    overlay.hidden = false;
    controls.aiSharedKey.focus();
  }
  function close() {
    if (busy) return;
    stopStatusCheck();
    clearKeys();
    overlay.hidden = true;
    try { window.sessionStorage.setItem("afm-ai-setup-skipped", "1"); } catch (ignore) {}
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  }
  function save() {
    if (busy) return;
    stopStatusCheck();
    busy = true;
    Array.prototype.forEach.call(overlay.querySelectorAll("input, button, a[href]"), function (node) { node.disabled = true; });
    message("正在加密并保存，请稍候…");
    window.setTimeout(function () {
      try {
        store.save(file, { separate: false, sharedKey: controls.aiSharedKey.value }, revision);
        revision = store.readRaw(file);
        clearKeys();
        ["aiSharedKey"].forEach(function (id) { controls[id].placeholder = "已保存，留空保留原密钥"; });
        controls.aiSettingsSkip.textContent = "完成";
        message("密钥已加密保存，正在确认本地服务读取状态…");
        window.dispatchEvent(new Event("afm-ai-config-saved"));
        checkSavedService();
      } catch (error) { message(error.message || "保存失败，原配置保持不变。"); }
      finally {
        busy = false;
        Array.prototype.forEach.call(overlay.querySelectorAll("input, button, a[href]"), function (node) { node.disabled = false; });
      }
    }, 40);
  }
  function stopStatusCheck() {
    window.clearInterval(serviceTimer); window.clearTimeout(startTimer);
    [statusRequest, statusResponse].forEach(function (p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (ignore) {} });
    serviceTimer = startTimer = null; statusRequest = statusResponse = null;
  }
  function checkSavedService() {
    var dir = path.join(dataDir, "requests"), start = Date.now();
    var id = "afm_settings_" + start + "_" + Math.floor(Math.random() * 100000);
    try {
      fs.mkdirSync(dir, { recursive: true });
      statusRequest = path.join(dir, id + ".request.json"); statusResponse = path.join(dir, id + ".response.json");
      fs.writeFileSync(statusRequest + ".tmp", JSON.stringify({ action: "config-status" }), "utf8");
      fs.renameSync(statusRequest + ".tmp", statusRequest);
    } catch (error) { message("配置已保存，但服务检测未启动。可重新打开插件后使用。"); return; }
    serviceTimer = window.setInterval(function () {
      if (fs.existsSync(statusResponse)) {
        var result;
        try { result = JSON.parse(fs.readFileSync(statusResponse, "utf8")); } catch (ignore) {}
        stopStatusCheck();
        message(result && result.ok && result.settingsVersion === 1 ? "已保存并生效。下次打开自动使用；模型权限可在 AI 工具中检测。" : "配置已保存。当前服务需更新或重启，请关闭后重新打开插件并检测服务。");
      } else if (Date.now() - start > 9000) {
        stopStatusCheck();
        message("配置已保存，但本地 AI 服务未响应。请安装 Node.js 18 或更高版本，再重开插件。无需重新填写密钥。");
      }
    }, 250);
    startTimer = window.setTimeout(function () {
      try {
        var launcher = path.join(process.env.APPDATA || "", "AFMAnimeRuntime", "node", "node.exe");
        var env = Object.assign({}, process.env, { AE3_AI_SERVICE_DIR: dataDir });
        var child = nodeRequire("child_process").spawn(fs.existsSync(launcher) ? launcher : "node", [path.join(root, "ai-service", "ai-expression-service.js")], { cwd: path.join(root, "ai-service"), env: env, windowsHide: true, detached: true, stdio: "ignore" });
        child.on("error", function () { stopStatusCheck(); message("配置已保存；请安装 Node.js 18 或更高版本，再打开 AI 工具。"); });
        child.unref();
      } catch (error) { stopStatusCheck(); message("配置已保存；本地服务启动失败，请检查 Node.js 运行环境。"); }
    }, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
}());
