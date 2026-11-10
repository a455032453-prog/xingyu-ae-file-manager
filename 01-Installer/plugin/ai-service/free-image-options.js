"use strict";

const models = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gemini-nano-banana-2.1"];
const ratios = ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "4:5"];

// Same selected model, provider-specific name. Never substitute token-priced
// variants or a different model when the requested version is unavailable.
const lkAliases = {
  "gpt-image-2": "tt-image-2",
  "gpt-image-2.5-sunburst": "tt-image-2.5-sunburst",
  "gpt-image-2.5-flare": "tt-image-2.5-flare",
  "gemini-nano-banana-2.1": "banana-2.1"
};
function resolveProviderModels(base, available) {
  let lkProvider = false;
  try { lkProvider = new URL(base).hostname === "api.lk888.ai"; } catch {}
  const resolved = {};
  for (const model of models) {
    if (available.includes(model)) resolved[model] = model;
    else if (lkProvider && available.includes(lkAliases[model])) resolved[model] = lkAliases[model];
  }
  return resolved;
}

// Resolve target dimensions once; the provider adapter translates these into
// the selected model's request format. Do not upscale the returned image.
function resolveOptions(payload, config) {
  const model = payload.freeImageModel || config.imageModel || models[0];
  if (!models.includes(model)) throw new Error("请选择 AI 生图支持的图片模型");
  const legacy = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3", "1280x720": "16:9", "720x1280": "9:16" };
  const ratio = payload.freeRatio || legacy[payload.freeSize] || "1:1";
  const resolution = payload.freeResolution || "1K";
  if (!ratios.includes(ratio)) throw new Error("不支持的生图比例");
  if (!["1K", "2K", "4K"].includes(resolution)) throw new Error("请选择 1K、2K 或 4K 分辨率");
  const count = Number(payload.freeCount || 1);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("生成数量应为 1 至 4 张");
  const edge = { "1K": 1024, "2K": 2048, "4K": 4096 }[resolution];
  const parts = ratio.split(":").map(Number);
  const longest = Math.max(...parts);
  const dimensions = parts.map(value => Math.round(edge * value / longest / 16) * 16);
  return { model, ratio, resolution, count, size: dimensions.join("x") };
}

module.exports = { models, ratios, resolveOptions, resolveProviderModels };
