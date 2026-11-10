const http = require("http");
const fs = require("fs");
const path = require("path");
const freeImageOptions = require("./free-image-options");
const pandaiImageAdapter = require("./pandai-image-adapter");
const configStore = require("./config-store");

const baseDir = process.env.AE3_AI_SERVICE_DIR || path.join(process.env.APPDATA || require("os").homedir(), "AEFileManager-Anime");
const configPath = path.join(baseDir, "ai-service-config.json");
const logPath = path.join(baseDir, "ai-expression-service.log");
const serviceInfoPath = path.join(baseDir, "service-info.json");
const requestDir = path.join(baseDir, "requests");
const generatedImageDir = path.join(baseDir, "generated-images");

function readConfig() {
  const fallback = {
    port: 48742,
    apiBaseUrl: "https://api.lk888.ai/v1",
    apiKey: "",
    imageApiBaseUrl: "https://api.lk888.ai/v1",
    imageApiKey: "",
    imageModel: "gpt-image-2",
    imageSize: "1024x1024",
    textApiBaseUrl: "",
    textApiKey: "",
    textModel: "gpt-5.6",
    model: "gpt-5.6",
    temperature: 0.2,
    timeoutMs: 60000,
    imageTimeoutMs: 180000
  };

  if (!fs.existsSync(configPath)) {
    return fallback;
  }

  const userConfig = configStore.read(configPath);
  return Object.assign(fallback, userConfig);
}

function log(message) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "http://127.0.0.1"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    req.on("error", reject);
  });
}

function extractJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI 未返回 JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeType(type, fallback) {
  const allowed = {
    "transform.opacity": true,
    "transform.scale": true,
    "transform.rotation": true,
    "transform.position": true,
    "transform.anchorPoint": true
  };
  return allowed[type] ? type : fallback;
}

function extFromContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("webp")) return ".webp";
  return ".png";
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg"
    ? "image/jpeg"
    : ext === ".webp"
      ? "image/webp"
      : "image/png";
  const b64 = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

function makeFreeImagePrompt(payload) {
  const prompt = String(payload.freePrompt || "").trim();
  if (!prompt) throw new Error("AI 生图提示词不能为空");
  return prompt;
}

let imageCapabilitiesCache = { identity: "", expiresAt: 0, value: null };
async function getFreeImageModels(config, force = false) {
  const apiKey = config.imageApiKey || config.apiKey;
  if (!apiKey) return { ok: false, error: "未配置图片服务密钥", models: [] };
  const base = String(config.imageApiBaseUrl || config.apiBaseUrl || "").replace(/\/$/, "");
  const identity = JSON.stringify([base, apiKey]);
  if (!force && imageCapabilitiesCache.identity === identity && imageCapabilitiesCache.expiresAt > Date.now()) return imageCapabilitiesCache.value;
  try {
    const response = await fetchWithTimeout(base + "/models", { headers: { Authorization: `Bearer ${apiKey}` } }, 15000);
    if (!response.ok) throw new Error("图片模型列表 HTTP " + response.status);
    const result = await response.json();
    if (!Array.isArray(result.data)) throw new Error("图片模型列表格式不正确");
    const available = result.data.map(item => item && item.id).filter(id => typeof id === "string");
    const resolvedModels = freeImageOptions.resolveProviderModels(base, available);
    const value = { ok: true, models: Object.keys(resolvedModels), resolvedModels, generationVerified: false };
    imageCapabilitiesCache = { identity, expiresAt: Date.now() + 30000, value };
    return value;
  } catch (error) {
    return { ok: false, error: error.message, models: [] };
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

let modelCapabilitiesCache = { expiresAt: 0, value: null, identity: "" };

function getTextConfig(config, payload = {}) {
  return {
    apiBaseUrl: String(payload.apiBaseUrl || config.textApiBaseUrl || config.apiBaseUrl || "").replace(/\/$/, ""),
    apiKey: String(payload.apiKey || config.textApiKey || config.apiKey || ""),
    model: String(payload.model || config.textModel || config.model || "gpt-5.6")
  };
}

function resolveProviderModel(model, availableModels) {
  const requested = String(model || "").trim();
  const aliases = {
    "gpt-5.6": ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"],
    "gemini-3-pro": ["gemini-3-pro", "gemini-3-pro-preview"]
  };
  const candidates = aliases[requested] || [requested];
  if (Array.isArray(availableModels) && availableModels.length) {
    for (const candidate of candidates) if (availableModels.includes(candidate)) return candidate;
  }
  return candidates[0];
}

async function getModelCapabilities(config) {
  const now = Date.now();
  const textConfig = getTextConfig(config);
  const identity = JSON.stringify([textConfig.apiBaseUrl, textConfig.apiKey, textConfig.model]);
  if (modelCapabilitiesCache.identity !== identity) modelCapabilitiesCache = { expiresAt: 0, value: null, identity: identity };
  if (modelCapabilitiesCache.value && modelCapabilitiesCache.expiresAt > now) return modelCapabilitiesCache.value;
  if (!textConfig.apiKey || !textConfig.apiBaseUrl) {
    return { ok: false, textReady: false, model: textConfig.model, models: [], error: "未配置文本模型 API Key" };
  }
  try {
    const response = await fetchWithTimeout(`${textConfig.apiBaseUrl}/models`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${textConfig.apiKey}` }
    }, 15000);
    const body = await response.text();
    if (!response.ok) throw new Error(`模型列表接口错误 ${response.status}`);
    const data = JSON.parse(body);
    const models = Array.isArray(data.data) ? data.data.map(item => String(item && item.id || "")).filter(Boolean) : [];
    const providerModel = resolveProviderModel(textConfig.model, models);
    const value = { ok: true, textReady: models.includes(providerModel), model: textConfig.model, providerModel, models };
    modelCapabilitiesCache = { expiresAt: now + 60000, value, identity };
    return value;
  } catch (error) {
    const value = { ok: false, textReady: false, model: textConfig.model, providerModel: textConfig.model, models: [], error: error.message };
    modelCapabilitiesCache = { expiresAt: now + 10000, value, identity };
    return value;
  }
}

async function assertTextModelAccess(config, payload) {
  const textConfig = getTextConfig(config, payload);
  const capabilities = await getModelCapabilities(config);
  const providerModel = resolveProviderModel(textConfig.model, capabilities.models);
  if (capabilities.ok && capabilities.models.length && !capabilities.models.includes(providerModel)) {
    throw new Error(`文本模型无权限：当前 Key 无法访问“${textConfig.model}”。当前 Key 只返回图片模型权限，请在 %APPDATA%\\AEFileManager-Anime\\ai-service-config.json 配置具备文本模型权限的 apiKey 或 textApiKey。`);
  }
  return Object.assign({}, textConfig, { providerModel: providerModel });
}

function extractImagePayloads(data) {
  if (!data) return null;
  const results = [];
  if (data.data && data.data[0]) {
    for (const item of data.data) {
      if (item && (item.b64_json || item.url)) results.push(item.b64_json || item.url);
    }
    return results.length ? results : null;
  }
  if (data.output && data.output[0]) {
    for (const item of data.output) {
      if (item.b64_json || item.url) results.push(item.b64_json || item.url);
      if (item.content && item.content[0]) {
        for (const content of item.content) {
          if (content && (content.b64_json || content.url)) results.push(content.b64_json || content.url);
        }
      }
    }
    return results.length ? results : null;
  }
  if (data.image) return [data.image];
  if (data.b64_json || data.url) return [data.b64_json || data.url];
  return null;
}

async function writeImageResult(config, imagePayload, prefix) {
  if (!fs.existsSync(generatedImageDir)) fs.mkdirSync(generatedImageDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.floor(Math.random() * 100000);
  if (/^https?:\/\//i.test(String(imagePayload))) {
    const response = await fetchWithTimeout(imagePayload, {}, config.imageTimeoutMs || config.timeoutMs || 180000);
    if (!response.ok) throw new Error(`下载生成图片失败 ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = extFromContentType(response.headers.get("content-type"));
    const outputPath = path.join(generatedImageDir, `${prefix}_${stamp}_${suffix}${ext}`);
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
  }

  const cleanBase64 = String(imagePayload).replace(/^data:image\/\w+;base64,/, "");
  const mimeMatch = /^data:(image\/\w+);base64,/.exec(String(imagePayload));
  const outputPath = path.join(generatedImageDir, `${prefix}_${stamp}_${suffix}${mimeMatch ? extFromContentType(mimeMatch[1]) : ".png"}`);
  fs.writeFileSync(outputPath, Buffer.from(cleanBase64, "base64"));
  return outputPath;
}

async function callFreeImageGeneration(config, payload) {
  const apiKey = config.imageApiKey || config.apiKey;
  if (!apiKey) throw new Error("缺少图片生成 API Key，请检查 ai-service-config.json");

  const apiBaseUrl = String(config.imageApiBaseUrl || config.apiBaseUrl).replace(/\/$/, "");
  const options = freeImageOptions.resolveOptions(payload, config);
  const capabilities = await getFreeImageModels(config);
  if (!capabilities.ok) throw new Error("无法确认图片模型：" + capabilities.error + "。请点击“检测模型”重试。");
  const providerModel = capabilities.resolvedModels[options.model];
  if (!providerModel) throw new Error("当前图片秘钥未开放所选模型“" + options.model + "”。请检测模型后选择已列出的型号，或在秘钥设置检查接口与权限。");
  options.providerModel = providerModel;
  const { model, size, count } = options;
  const requestedPaths = Array.isArray(payload.freeReferenceImagePaths) ? payload.freeReferenceImagePaths.slice() : [];
  if (payload.freeReferenceImagePath && !requestedPaths.includes(payload.freeReferenceImagePath)) requestedPaths.push(payload.freeReferenceImagePath);
  if (requestedPaths.length > 8) throw new Error("参考图最多 8 张");
  for (const file of requestedPaths) {
    if (typeof file !== "string" || !/\.(png|jpe?g|webp)$/i.test(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error("参考图已失效或格式不支持，请重新添加参考图");
    }
  }
  const referenceImagePaths = normalizeReferenceImagePaths({
    referenceImagePath: payload.freeReferenceImagePath,
    referenceImagePaths: payload.freeReferenceImagePaths
  });
  const prompt = makeFreeImagePrompt(payload);
  const outputPrefix = "afm_free_image";

  // lk888 exposes these models through its Images API; the legacy provider
  // used chat/native-Gemini routes for the same UI families.
  if (model !== "gpt-image-2" && new URL(apiBaseUrl).hostname !== "api.lk888.ai") {
    const result = await callProviderFreeImage(config, apiBaseUrl, apiKey, options, prompt, referenceImagePaths, outputPrefix);
    return Object.assign({}, result, { usedReference: referenceImagePaths.length > 0, referenceCount: referenceImagePaths.length, mode: "free", requestedSize: size, ratio: options.ratio, resolution: options.resolution });
  }

  if (referenceImagePaths.length) {
    try {
      const result = await callImageEdit(config, apiBaseUrl, apiKey, providerModel, size, prompt, referenceImagePaths, count, outputPrefix);
      return Object.assign({}, result, { model, providerModel, usedReference: true, referenceCount: referenceImagePaths.length, mode: "free", requestedSize: size, ratio: options.ratio, resolution: options.resolution });
    } catch (error) {
      log(`Free image reference generation failed without fallback: ${error.message}`);
      throw new Error(`AI 生图参考图处理失败，未使用无参考图回退：${error.message}`);
    }
  }

  const result = await callImageCreate(config, apiBaseUrl, apiKey, providerModel, size, prompt, "", count, outputPrefix);
  return Object.assign({}, result, { model, providerModel, usedReference: false, referenceCount: 0, mode: "free", requestedSize: size, ratio: options.ratio, resolution: options.resolution });
}

async function callProviderFreeImage(config, base, apiKey, options, prompt, references, outputPrefix) {
  const images = references.map(file => {
    const ext = path.extname(file).toLowerCase();
    return { mime: ext === ".webp" ? "image/webp" : /\.jpe?g/.test(ext) ? "image/jpeg" : "image/png", base64: fs.readFileSync(file).toString("base64") };
  });
  const request = pandaiImageAdapter.buildRequest(base, options, prompt, images);
  const outputPaths = [];
  for (let i = 0; i < options.count; i++) {
    const response = await fetchWithTimeout(request.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request.body)
    }, config.imageTimeoutMs || 180000);
    const text = await response.text();
    if (!response.ok) {
      const access = response.status === 401 || response.status === 403;
      const missing = response.status === 404 || /model_not_found/i.test(text);
      const message = access ? "：图片秘钥或模型权限被接口拒绝，请检查秘钥设置。" : missing ? "：当前服务的此接口不提供所选模型，请检查模型名称及图片接口路径。" : " 生图接口错误 HTTP " + response.status + "：" + text.slice(0, 350);
      throw new Error(options.model + message + (outputPaths.length ? " 已有 " + outputPaths.length + " 张保存，可刷新结果查看。" : ""));
    }
    const payloads = pandaiImageAdapter.extractImages(JSON.parse(text));
    if (!payloads.length) throw new Error(options.model + " 未返回图片，仅返回文字或空结果。请检查服务商模型分组及生图能力；未切换模型或丢弃参考图重试。" + (outputPaths.length ? " 已有 " + outputPaths.length + " 张保存，可刷新结果查看。" : ""));
    outputPaths.push(await writeImageResult(config, payloads[0], outputPrefix));
  }
  return { ok: true, imagePath: outputPaths[0], imagePaths: outputPaths, model: options.model, providerModel: options.providerModel, prompt };
}

function normalizeReferenceImagePaths(payload) {
  const paths = [];
  if (Array.isArray(payload.referenceImagePaths)) {
    for (const item of payload.referenceImagePaths) {
      if (item && fs.existsSync(item)) paths.push(item);
    }
  }
  if (payload.referenceImagePath && fs.existsSync(payload.referenceImagePath) && !paths.includes(payload.referenceImagePath)) {
    paths.push(payload.referenceImagePath);
  }
  return paths;
}

async function callImageEdit(config, apiBaseUrl, apiKey, model, size, prompt, referenceImagePaths, count, outputPrefix) {
  const outputPaths = [];
  const total = Math.max(1, Math.min(4, Number(count || 1)));
  for (let index = 0; index < total; index += 1) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    for (const referenceImagePath of referenceImagePaths) {
      const imageBytes = fs.readFileSync(referenceImagePath);
      const fileName = path.basename(referenceImagePath);
      const ext = path.extname(referenceImagePath).toLowerCase();
      const mime = ext === ".webp" ? "image/webp" : /\.jpe?g/.test(ext) ? "image/jpeg" : "image/png";
      form.append("image", new Blob([imageBytes], { type: mime }), fileName);
    }

    const response = await fetchWithTimeout(`${apiBaseUrl}/images/edits`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form
    }, config.imageTimeoutMs || 180000);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`图片参考生成接口错误 ${response.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text);
    const imagePayloads = extractImagePayloads(data);
    if (!imagePayloads || !imagePayloads[0]) throw new Error("图片接口未返回图片数据");
    outputPaths.push(await writeImageResult(config, imagePayloads[0], outputPrefix || "ai_image_ref"));
  }
  return { ok: true, imagePath: outputPaths[0], imagePaths: outputPaths, prompt, model, usedReference: true };
}

async function callImageCreate(config, apiBaseUrl, apiKey, model, size, prompt, referenceImagePath, count, outputPrefix) {
  const outputPaths = [];
  const total = Math.max(1, Math.min(4, Number(count || 1)));
  for (let index = 0; index < total; index += 1) {
    const body = {
      model,
      prompt,
      size,
      response_format: "b64_json"
    };
    const response = await fetchWithTimeout(`${apiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }, config.imageTimeoutMs || 180000);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`图片生成接口错误 ${response.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text);
    const imagePayloads = extractImagePayloads(data);
    if (!imagePayloads || !imagePayloads[0]) throw new Error("图片接口未返回图片数据");
    outputPaths.push(await writeImageResult(config, imagePayloads[0], outputPrefix || "ai_image"));
  }
  return { ok: true, imagePath: outputPaths[0], imagePaths: outputPaths, prompt, model, usedReference: false };
}

async function callAI(config, payload) {
  const textConfig = await assertTextModelAccess(config, payload);
  if (!textConfig.apiKey) {
    throw new Error("缺少 API Key，请检查 ai-service-config.json");
  }

  const targetType = normalizeType(payload.targetType, "transform.opacity");
  const targetLabel = payload.targetLabel || targetType;
  const variantCount = payload.variantCount === 3 ? 3 : 1;
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) {
    throw new Error("需求描述不能为空");
  }

  const systemPrompt = [
    "你是 After Effects 表达式工程师。",
    "只生成 AE Expression，不生成 JSX 脚本。",
    "表达式必须兼容 After Effects 2020 的 JavaScript Expression Engine。",
    "不要使用外部库，不要访问网络，不要依赖未说明的图层名称。",
    "优先给出可以直接粘贴到目标属性的表达式。",
    "必须严格遵守用户描述的方向：淡入是从低值到当前值，淡出是从当前值到低值。",
    "用户提到“帧”时，必须用 帧数 * thisComp.frameDuration 转换为秒，不要把帧当秒。",
    "不要擅自改写用户需求，例如不要把淡入写成淡出。",
    "返回严格 JSON，不要 Markdown，不要代码围栏。",
    variantCount === 3 ? 'JSON 顶层格式: {"variants":[方案1,方案2,方案3]}。必须返回恰好三个不同方案，每个方案字段为 name,type,code,remark,explanation,testTips。' : "JSON 字段: name,type,code,remark,explanation,testTips。",
    variantCount === 3 ? "三个方案必须都满足原需求和同一个目标属性，使用不同的实现、节奏或缓动；不得反转用户要求的方向，不得重复代码凑数。" : "输出一个方案。",
    "type 必须是 transform.opacity、transform.scale、transform.rotation、transform.position、transform.anchorPoint 之一。"
  ].join("\n");

  const userPrompt = [
    `目标属性: ${targetLabel} (${targetType})`,
    `用户需求: ${prompt}`,
    "",
    "要求:",
    "1. code 字段只放表达式代码。",
    "2. 如果需要参数，把参数集中放在表达式开头，并写中文注释。",
    "3. 如果用户提到帧数，表达式中必须出现 thisComp.frameDuration。",
    "4. 返回前自检 code 是否和用户需求方向一致。",
    "5. explanation 用中文简短说明原理。",
    "6. testTips 用中文说明怎么在 AE 里测试。"
  ].join("\n");

  const body = {
    model: textConfig.providerModel,
    temperature: config.temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = `${textConfig.apiBaseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${textConfig.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || /no access to model|model_not_found/i.test(text)) {
        throw new Error(`文本模型无权限：当前 Key 无法访问“${textConfig.model}”。请更换具备文本模型权限的 apiKey/textApiKey 后重试。`);
      }
      throw new Error(`AI 接口错误 ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = JSON.parse(text);
    const content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    const result = extractJson(content);
    if (variantCount === 3) {
      if (!Array.isArray(result.variants)) throw new Error("AI 未返回三个方案的结构，未自动重试，请调整描述后再试。");
      const seen = new Set();
      const variants = [0, 1, 2].map(index => {
        const item = result.variants[index];
        const code = item && typeof item.code === "string" ? item.code.trim() : "";
        if (!code) return { ok: false, error: "此方案未返回有效表达式代码。" };
        if (normalizeType(item.type, targetType) !== targetType) return { ok: false, error: "此方案的目标属性与所选属性不一致，未作为可用结果。" };
        if (seen.has(code)) return { ok: false, error: "此方案与前一个结果重复，未作为新方案使用。" };
        seen.add(code);
        return {
          ok: true, name: String(item.name || "方案 " + (index + 1)), type: targetType, code,
          remark: String(item.remark || "AI生成"), explanation: String(item.explanation || ""), testTips: String(item.testTips || "")
        };
      });
      if (!variants.some(item => item.ok)) throw new Error("AI 没有返回有效表达式代码，未自动重试。");
      return { ok: true, model: textConfig.model, providerModel: textConfig.providerModel, variants };
    }
    return {
      ok: true,
      model: textConfig.model,
      providerModel: textConfig.providerModel,
      name: result.name || "AI生成表达式",
      type: normalizeType(result.type, targetType),
      code: String(result.code || "").trim(),
      remark: result.remark || "AI生成",
      explanation: result.explanation || "",
      testTips: result.testTips || ""
    };
  } finally {
    clearTimeout(timer);
  }
}

const config = readConfig();
if (!fs.existsSync(requestDir)) fs.mkdirSync(requestDir, { recursive: true });
const activeBridgeRequests = new Set();

async function processBridgeRequest(name) {
  const requestPath = path.join(requestDir, name);
  const responsePath = path.join(requestDir, name.replace(".request.json", ".response.json"));
  const workingPath = path.join(requestDir, name.replace(".request.json", ".working"));
  try {
    fs.renameSync(requestPath, workingPath);
  } catch {
    return;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(workingPath, "utf8").replace(/^\uFEFF/, ""));
    const config = readConfig(); // Per-request snapshot: saved credentials apply without restarting.
    let result;
    if (payload.action === "config-status") {
      result = { ok: true, settingsVersion: 1, imageConfigured: !!(config.imageApiKey || config.apiKey), textConfigured: !!(config.textApiKey || config.apiKey) };
    } else if (payload.action === "health") {
      const capabilities = await getModelCapabilities(config);
      result = { ok: true, model: config.textModel || config.model, apiBaseUrl: config.textApiBaseUrl || config.apiBaseUrl, port: config.port, textReady: !!capabilities.textReady, textModels: capabilities.models, capabilityError: capabilities.error || "" };
    } else if (payload.action === "generate-expression") {
      result = await callAI(config, payload);
    } else if (payload.action === "generate-free-image") {
      result = await callFreeImageGeneration(config, payload);
    } else if (payload.action === "free-image-models") {
      result = await getFreeImageModels(config, true);
    } else if (payload.action === "shutdown") {
      result = { ok: true, message: "AI service shutting down" };
      fs.writeFileSync(responsePath, JSON.stringify(result, null, 2), "utf8");
      setTimeout(() => process.exit(0), 200);
      return;
    } else {
      result = { ok: false, error: "Unknown bridge action" };
    }
    fs.writeFileSync(responsePath, JSON.stringify(result, null, 2), "utf8");
  } catch (error) {
    fs.writeFileSync(responsePath, JSON.stringify({ ok: false, error: error.message }, null, 2), "utf8");
    log(error.stack || error.message);
  } finally {
    try { fs.unlinkSync(workingPath); } catch {}
  }
}

function processFileBridge() {
  let files;
  try {
    files = fs.readdirSync(requestDir)
      .filter(name => name.endsWith(".request.json"))
      .sort();
  } catch (error) {
    log(error.stack || error.message);
    return;
  }

  for (const name of files) {
    if (activeBridgeRequests.has(name)) continue;
    activeBridgeRequests.add(name);
    processBridgeRequest(name).finally(() => activeBridgeRequests.delete(name));
  }
}

setInterval(processFileBridge, 500);

const server = http.createServer(async (req, res) => {
  try {
    const config = readConfig();
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return;
    }

    if (req.url === "/health") {
      const capabilities = await getModelCapabilities(config);
      sendJson(res, 200, {
        ok: true,
        model: config.textModel || config.model,
        apiBaseUrl: config.textApiBaseUrl || config.apiBaseUrl,
        textReady: !!capabilities.textReady,
        textModels: capabilities.models,
        capabilityError: capabilities.error || ""
      });
      return;
    }

    if (req.url === "/shutdown") {
      sendJson(res, 200, { ok: true, message: "AI service shutting down" });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    if (req.url === "/generate-expression") {
      const payload = await readBody(req);
      const result = await callAI(config, payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.url === "/generate-free-image") {
      const payload = await readBody(req);
      const result = await callFreeImageGeneration(config, payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.url === "/free-image-models") {
      sendJson(res, 200, await getFreeImageModels(config, true));
      return;
    }

    sendJson(res, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    log(error.stack || error.message);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.on("error", error => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. The AI service may already be running.`);
    log(`Port ${config.port} is already in use. The AI service may already be running.`);
    process.exit(0);
  }
  console.error(error);
  log(error.stack || error.message);
  process.exit(1);
});

server.listen(config.port, "127.0.0.1", () => {
  fs.writeFileSync(serviceInfoPath, JSON.stringify({
    ok: true,
    port: config.port,
    model: config.model,
    apiBaseUrl: config.apiBaseUrl,
    baseDir,
    configPath,
    startedAt: new Date().toISOString()
  }, null, 2), "utf8");
  log(`AI expression service listening on http://127.0.0.1:${config.port}`);
  console.log(`AI expression service listening on http://127.0.0.1:${config.port}`);
});
