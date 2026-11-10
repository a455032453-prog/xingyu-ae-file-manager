"use strict";
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var cache = { raw: null, keys: null };
var defaultBase = "https://api.lk888.ai";

function readRaw(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "";
}
function parse(raw) {
  if (!raw) return {};
  try {
    var config = JSON.parse(raw);
    if (!config || Array.isArray(config) || typeof config !== "object") throw new Error();
    return config;
  } catch (error) { throw new Error("AI 配置文件格式异常，请保留原文件并修复 JSON 格式后重试。"); }
}
function protect(mode, input) {
  if (process.platform !== "win32") throw new Error("本版本的密钥加密保存需要 Windows。");
  try {
    var executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return childProcess.execFileSync(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "protect-ai-keys.ps1"), "-Mode", mode], {
      input: input, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (error) { throw new Error("无法使用当前 Windows 用户加密或读取密钥；请在本机重新填写密钥。"); }
}
function decode(raw) {
  var config = parse(raw);
  if (config.credentialVault) {
    if (config.credentialVault.type !== "windows-dpapi-v1") throw new Error("不支持的 AI 密钥存储格式。");
    if (cache.raw !== config.credentialVault.data) {
      var keys;
      try { keys = JSON.parse(protect("unprotect", config.credentialVault.data)); }
      catch (error) { throw new Error("无法读取此 Windows 用户的密钥，请打开 AI 设置重新填写。"); }
      cache = { raw: config.credentialVault.data, keys: keys };
    }
    ["apiKey", "textApiKey", "imageApiKey"].forEach(function (key) { config[key] = String(cache.keys[key] || ""); });
  }
  return fixedBases(config);
}
function read(file) { return decode(readRaw(file)); }
function fixedBases(config) {
  config.apiBaseUrl = config.imageApiBaseUrl = config.textApiBaseUrl = defaultBase + "/v1";
  return config;
}
function keyValue(value) {
  var key = String(value || "").trim();
  if (!key || key.length > 4096 || /\s/.test(key)) throw new Error("请填写有效密钥，不能包含空格或换行。");
  return key;
}
function save(file, draft, expectedRaw) {
  var raw = readRaw(file);
  if (raw !== expectedRaw) throw new Error("配置已在其他窗口更新，请关闭后重新打开 AI 设置。");
  var config = parse(raw), previous;
  try { previous = decode(raw); } catch (error) { previous = {}; }
  var imageKey, textKey, sharedKey = "";
  if (draft.separate) {
    imageKey = keyValue(draft.imageKey || previous.imageApiKey || previous.apiKey);
    textKey = keyValue(draft.textKey || previous.textApiKey || previous.apiKey);
  } else {
    // Never silently choose one of two different existing keys when merging.
    var oldImage = previous.imageApiKey || previous.apiKey || "";
    var oldText = previous.textApiKey || previous.apiKey || "";
    sharedKey = keyValue(draft.sharedKey || (oldImage === oldText ? oldImage : ""));
    imageKey = textKey = sharedKey;
  }
  fixedBases(config);
  config.keyMode = draft.separate ? "separate" : "shared";
  config.credentialVault = { type: "windows-dpapi-v1", data: protect("protect", JSON.stringify({ apiKey: sharedKey, textApiKey: textKey, imageApiKey: imageKey })) };
  config.apiKey = config.textApiKey = config.imageApiKey = "";
  if (!config.imageModel) config.imageModel = "gpt-image-2";
  if (!config.textModel) config.textModel = "gpt-5.6";
  if (!config.model) config.model = config.textModel;
  if (!config.port) config.port = 48742;
  return writeAtomic(file, config, raw);
}
function writeAtomic(file, config, raw) {
  var temporary = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 384 });
    if (readRaw(file) !== raw) throw new Error("配置已在其他窗口更新，请重新打开设置。");
    fs.renameSync(temporary, file);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (ignore) {}
    throw new Error(error.message && /其他窗口/.test(error.message) ? error.message : "保存失败，请检查本机配置目录的写入权限；原配置未替换。");
  }
  return config;
}
function clear(file, expectedRaw) {
  var raw = readRaw(file);
  if (raw !== expectedRaw) throw new Error("配置已在其他窗口更新，请关闭后重新打开 AI 设置。");
  // Clearing must also work when a vault is unreadable or JSON has been damaged.
  var config;
  try { config = parse(raw); } catch (ignore) { config = {}; }
  delete config.credentialVault;
  ["apiKey", "textApiKey", "imageApiKey"].forEach(function (key) { delete config[key]; });
  fixedBases(config);
  if (!config.port) config.port = 48742;
  config.keyMode = "shared";
  var result = writeAtomic(file, config, raw);
  cache = { raw: null, keys: null };
  return result;
}
module.exports = { read: read, readRaw: readRaw, save: save, clear: clear, defaultBase: defaultBase };
