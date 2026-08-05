import path from "node:path";

import { fetchBinary } from "./source.mjs";
import { interpolateEnvironment } from "./utils.mjs";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);
const ALLOWED_MIME_TYPES = new Set(MIME_BY_EXTENSION.values());

function renderAttachmentUrl(template, variables) {
  return String(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name) => {
    if (variables[name] == null) throw new Error(`附件 URL 模板缺少变量：${name}`);
    return name === "baseUrl"
      ? String(variables[name]).replace(/\/+$/g, "")
      : encodeURIComponent(String(variables[name]));
  });
}

function resolveAttachmentUrl(config, bugId, attachment) {
  const candidate =
    attachment.downloadUrl || attachment.url || attachment.webPath;
  if (candidate) {
    const base = new URL(config.source.baseUrl);
    const url = new URL(candidate, base);
    if (
      base.protocol === "https:" &&
      url.protocol === "http:" &&
      url.hostname === base.hostname &&
      (!url.port || url.port === "80")
    ) {
      url.protocol = "https:";
      url.port = base.port;
    }
    return url;
  }
  if (config.source.attachmentUrlTemplate) {
    return new URL(
      renderAttachmentUrl(config.source.attachmentUrlTemplate, {
        baseUrl: config.source.baseUrl,
        bugId,
        fileId: attachment.id,
      }),
      config.source.baseUrl,
    );
  }
  const error = new Error("该附件没有可用下载地址，请配置 source.attachmentUrlTemplate");
  error.code = "ATTACHMENT_DOWNLOAD_UNSUPPORTED";
  throw error;
}

function assertSameOrigin(url, baseUrl) {
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) {
    const error = new Error("附件地址与禅道地址不同源，已拒绝下载");
    error.code = "ATTACHMENT_CROSS_ORIGIN";
    throw error;
  }
}

function detectedMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = bytes.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return undefined;
}

function normalizedDeclaredMime(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLocaleLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function validateImage(attachment, response, bytes, maxBytes) {
  if (bytes.length > maxBytes) {
    throw new Error(`图片附件超过大小限制（${maxBytes} 字节）`);
  }
  const detected = detectedMimeType(bytes);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected)) {
    throw new Error("附件内容不是受支持的 PNG、JPEG、WebP 或 GIF 图片");
  }
  const declared = normalizedDeclaredMime(
    response.headers.get("content-type") || attachment.mimeType,
  );
  if (declared && (!ALLOWED_MIME_TYPES.has(declared) || declared !== detected)) {
    throw new Error("附件声明类型与实际图片内容不一致");
  }
  const extension = path.extname(attachment.name || "").toLocaleLowerCase();
  if (extension && (!MIME_BY_EXTENSION.has(extension) || MIME_BY_EXTENSION.get(extension) !== detected)) {
    throw new Error("附件扩展名与实际图片内容不一致");
  }
  return detected;
}

async function requestHeaders(config) {
  if (config.source.type === "zentao-v1") {
    const tokenEnv = config.source.tokenEnv || "ZENTAO_TOKEN";
    let token = process.env[tokenEnv];
    if (!token && config.source.tokenFile) {
      const { readFile } = await import("node:fs/promises");
      token = (await readFile(config.source.tokenFile, "utf8")).trim();
    }
    if (!token) throw new Error("缺少禅道 Token，无法下载附件");
    return {
      ...interpolateEnvironment(config.source.headers ?? {}),
      Token: token,
    };
  }
  return interpolateEnvironment(config.source.headers ?? {});
}

export function findBugAttachment(item, attachmentId) {
  const attachment = (item?.bug?.attachments ?? []).find(
    (candidate) => String(candidate.id) === String(attachmentId),
  );
  if (!attachment) {
    throw new Error(`Bug ${item?.bug?.id || "未知"} 中不存在附件 ${attachmentId}`);
  }
  return attachment;
}

export async function downloadBugImage(config, bugId, attachment, options = {}) {
  const maxBytes = Number(config.source.maxAttachmentBytes ?? DEFAULT_MAX_BYTES);
  if (attachment.size != null && attachment.size > maxBytes) {
    throw new Error(`图片附件超过大小限制（${maxBytes} 字节）`);
  }
  let url = resolveAttachmentUrl(config, bugId, attachment);
  const headers = await requestHeaders(config);
  const fetchOptions = {
    headers,
    retries: config.source.requestRetries,
    timeoutMs: config.source.requestTimeoutMs,
    retryDelayMs: config.source.retryDelayMs,
    redirect: "manual",
  };

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertSameOrigin(url, config.source.baseUrl);
    const response = await fetchBinary(url.href, fetchOptions, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("附件重定向无效或次数过多");
      url = new URL(location, url);
      continue;
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`图片附件超过大小限制（${maxBytes} 字节）`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = validateImage(attachment, response, bytes, maxBytes);
    return {
      metadata: {
        bugId: String(bugId),
        attachmentId: String(attachment.id),
        name: attachment.name,
        mimeType,
        size: bytes.length,
      },
      data: bytes.toString("base64"),
    };
  }
  throw new Error("附件下载失败");
}
