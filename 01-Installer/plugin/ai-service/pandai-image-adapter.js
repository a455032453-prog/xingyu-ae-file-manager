"use strict";

// UI family determines the protocol; providerModel comes from this account's list.
function buildRequest(base, options, prompt, references) {
  const model = options.providerModel || options.model;
  const nano = options.model === "gemini-nano-banana-2.1";
  if (nano) {
    return {
      url: base.replace(/\/v1\/?$/, "") + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }].concat(references.map(image => ({ inlineData: { mimeType: image.mime, data: image.base64 } }))) }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: options.ratio, imageSize: options.resolution } }
      }
    };
  }
  return {
    url: base + "/chat/completions",
    body: {
      model,
      stream: false,
      messages: [
        { role: "system", content: "请根据用户描述和全部参考图生成图片并返回图片结果。目标比例 " + options.ratio + "，目标分辨率 " + options.resolution + "（约 " + options.size + "）；以当前模型实际支持为准。不要仅返回文字描述。" },
        { role: "user", content: [{ type: "text", text: prompt }].concat(references.map(image => ({ type: "image_url", image_url: { url: "data:" + image.mime + ";base64," + image.base64 } }))) }
      ]
    }
  };
}

function extractImages(data) {
  const images = [];
  function add(value) {
    if (typeof value === "string" && (/^data:image\/(png|jpe?g|webp);base64,[a-z\d+/=\s]+$/i.test(value) || /^https?:\/\//i.test(value))) images.push(value);
  }
  function parts(content) {
    if (typeof content === "string") {
      // Only explicit image markup/data URIs; plain URLs in prose are not images.
      const expression = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/(?:png|jpe?g|webp);base64,[a-z\d+/=]+)\)|(data:image\/(?:png|jpe?g|webp);base64,[a-z\d+/=]+)/gi;
      let match;
      while ((match = expression.exec(content))) add(match[1] || match[2]);
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach(part => {
      if (!part || typeof part !== "object") return;
      const inline = part.inlineData || part.inline_data;
      if (inline && /^image\/(png|jpe?g|webp)$/i.test(inline.mimeType || inline.mime_type || "") && inline.data) add("data:" + (inline.mimeType || inline.mime_type) + ";base64," + inline.data);
      const url = part.image_url;
      if (url) add(typeof url === "string" ? url : url.url);
      if (part.type === "image" && part.url) add(part.url);
      if (part.b64_json) add("data:image/png;base64," + part.b64_json);
      if (part.text) parts(part.text);
    });
  }
  (data.candidates || []).forEach(candidate => parts(candidate.content && candidate.content.parts));
  (data.choices || []).forEach(choice => {
    if (!choice.message) return;
    parts(choice.message.content);
    parts(choice.message.images);
  });
  (data.data || []).forEach(item => {
    if (item.b64_json) add("data:image/png;base64," + item.b64_json);
    else add(item.url);
  });
  return Array.from(new Set(images));
}

module.exports = { buildRequest, extractImages };
