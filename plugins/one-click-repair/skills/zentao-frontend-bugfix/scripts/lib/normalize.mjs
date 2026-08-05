import { createHash } from "node:crypto";
import { getByPath, printableValue, stripHtml } from "./utils.mjs";

const DEFAULT_FIELDS = {
  id: "id",
  title: "title",
  description: "description",
  steps: "steps",
  severity: "severity",
  priority: "priority",
  affectedVersion: "affectedVersion",
  resolvedVersion: "resolvedVersion",
  product: "product",
  project: "project",
  execution: "execution",
  executionName: "executionName",
  module: "module",
  status: "status",
  assignee: "assignee",
  url: "url",
  attachments: "attachments",
  comments: "comments",
};

function mapped(raw, fields, name) {
  return getByPath(raw, fields[name] ?? DEFAULT_FIELDS[name]);
}

function numericOrText(value) {
  if (value == null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : printableValue(value);
}

function commentText(comment) {
  if (typeof comment === "string") return stripHtml(comment);
  if (!comment || typeof comment !== "object") return "";
  return stripHtml(
    comment.comment ??
      comment.content ??
      comment.text ??
      comment.desc ??
      "",
  );
}

function attachmentEntries(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

export function normalizeAttachments(value) {
  return attachmentEntries(value).flatMap(([fallbackId, attachment]) => {
    if (!attachment || typeof attachment !== "object") return [];
    const id = printableValue(
      attachment.id ?? attachment.fileID ?? attachment.fileId ?? fallbackId,
    ).trim();
    if (!id) return [];
    const name = printableValue(
      attachment.name ??
        attachment.title ??
        attachment.fileName ??
        attachment.filename ??
        `attachment-${id}`,
    ).trim();
    const numericSize = Number(attachment.size ?? attachment.fileSize);
    const result = {
      id,
      name,
      mimeType: printableValue(
        attachment.mimeType ?? attachment.contentType ?? attachment.mime,
      ).trim(),
      ...(Number.isFinite(numericSize) && numericSize >= 0
        ? { size: numericSize }
        : {}),
    };
    for (const field of ["downloadUrl", "url", "webPath"]) {
      const candidate = printableValue(attachment[field]).trim();
      if (candidate) result[field] = candidate;
    }
    return [result];
  });
}

const INLINE_IMAGE_MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
]);

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;|&#0*39;|&#x0*27;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)));
}

function imageAttribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>]+))`, "iu"),
  );
  return decodeHtmlAttribute(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function inlineImageId(url) {
  const pathMatch = url.pathname.match(/(?:^|\/)(?:file-(?:read|download)-)([0-9]+)/iu);
  const queryId = url.searchParams.get("fileID") || url.searchParams.get("fileId");
  if (pathMatch?.[1]) return pathMatch[1];
  if (queryId && /^[0-9]+$/u.test(queryId)) return queryId;
  return `inline-${createHash("sha256").update(url.href).digest("hex").slice(0, 12)}`;
}

function inlineImageName(url, alt, id) {
  const encodedPathName = url.pathname.split("/").pop() || "";
  let pathName = encodedPathName;
  try {
    pathName = decodeURIComponent(encodedPathName);
  } catch {
    // Preserve a malformed but printable filename instead of failing the entire Bug pull.
  }
  pathName = pathName.trim();
  const altExtension = alt.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLocaleLowerCase();
  if (alt && INLINE_IMAGE_MIME_TYPES.has(altExtension)) return alt;
  return pathName || alt || `inline-image-${id}`;
}

export function extractInlineImageAttachments(value, baseUrl) {
  const html = printableValue(value);
  return [...html.matchAll(/<img\b[^>]*>/giu)].flatMap((match) => {
    const source = imageAttribute(match[0], "src");
    if (!source || /^(?:data|javascript|blob):/iu.test(source)) return [];
    const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(source) || source.startsWith("//");
    let url;
    try {
      const resolutionBase = baseUrl
        ? `${String(baseUrl).replace(/\/+$/u, "")}/`
        : "https://inline-image.invalid/";
      url = new URL(source, resolutionBase);
    } catch {
      return [];
    }
    if (!["http:", "https:"].includes(url.protocol)) return [];
    const id = inlineImageId(url);
    const name = inlineImageName(url, imageAttribute(match[0], "alt"), id);
    const extension = name.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLocaleLowerCase();
    return [{
      id,
      name,
      mimeType: INLINE_IMAGE_MIME_TYPES.get(extension) || "",
      ...(absolute
        ? { url: source }
        : { webPath: `${url.pathname}${url.search}` }),
      source: "inline-html",
    }];
  });
}

function mergeAttachments(...groups) {
  const merged = [];
  for (const attachment of groups.flat()) {
    const location = attachment.downloadUrl || attachment.url || attachment.webPath;
    const existing = merged.find((candidate) =>
      candidate.id === attachment.id ||
      (location && location === (candidate.downloadUrl || candidate.url || candidate.webPath)));
    if (!existing) {
      merged.push({ ...attachment });
      continue;
    }
    for (const [key, value] of Object.entries(attachment)) {
      if ((existing[key] == null || existing[key] === "") && value != null && value !== "") {
        existing[key] = value;
      }
    }
  }
  return merged;
}

function commentHtml(comment) {
  if (typeof comment === "string") return comment;
  if (!comment || typeof comment !== "object") return "";
  return comment.comment ?? comment.content ?? comment.text ?? comment.desc ?? "";
}

const REPOSITORY_LABELS = [
  "问题代码仓库",
  "问题仓库",
  "代码仓库",
  "所属仓库",
  "仓库名称",
  "前端项目",
  "所属项目",
  "属于项目",
];

function extractRepositoryProjectFromText(text) {
  const labels = REPOSITORY_LABELS.join("|");
  const match = String(text ?? "").match(
    new RegExp(`(?:^|\\n|[【\\[])(?:${labels})\\s*[:：]\\s*([^\\r\\n]+)`, "iu"),
  );
  if (!match?.[1]) return undefined;
  const name = match[1]
    .trim()
    .replace(/^[`"'“‘]+|[`"'”’]+$/gu, "")
    .split(/\s*(?:[。；;，,]|【|\[)\s*/u, 1)[0]
    .trim();
  if (!name) return undefined;
  const labelMatch = match[0].match(new RegExp(`(?:${labels})`, "iu"));
  return {
    name,
    label: labelMatch?.[0] || "代码仓库",
  };
}

export function extractRepositoryProjectDetails({
  comments = [],
  description = "",
  steps = "",
  title = "",
} = {}) {
  const items = Array.isArray(comments) ? comments : [comments];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = commentText(items[index]);
    const match = extractRepositoryProjectFromText(text);
    if (match) {
      return {
        ...match,
        source: "comment",
      };
    }
  }

  for (const [source, text] of [
    ["description", description],
    ["steps", steps],
    ["title", title],
  ]) {
    const match = extractRepositoryProjectFromText(text);
    if (match) {
      return {
        ...match,
        source,
      };
    }
  }

  return {
    name: "",
    label: "",
    source: "",
  };
}

export function extractRepositoryProject(comments = []) {
  return extractRepositoryProjectDetails({ comments }).name;
}

export function normalizeBug(raw, fields = {}, options = {}) {
  const mergedFields = { ...DEFAULT_FIELDS, ...fields };
  const id = printableValue(mapped(raw, mergedFields, "id")).trim();
  const comments = mapped(raw, mergedFields, "comments") ?? [];
  const rawTitle = mapped(raw, mergedFields, "title");
  const rawDescription = mapped(raw, mergedFields, "description");
  const rawSteps = mapped(raw, mergedFields, "steps");
  const title = stripHtml(rawTitle);
  const description = stripHtml(rawDescription);
  const steps = stripHtml(rawSteps);
  const explicitAttachments = normalizeAttachments(
    mapped(raw, mergedFields, "attachments"),
  );
  const commentValues = (Array.isArray(comments) ? comments : [comments]).map(commentHtml);
  const inlineAttachments = [rawDescription, rawSteps, ...commentValues]
    .flatMap((value) => extractInlineImageAttachments(value, options.baseUrl));
  const repositoryProject = extractRepositoryProjectDetails({
    comments,
    description,
    steps,
    title,
  });
  return {
    id,
    title,
    description,
    steps,
    severity: numericOrText(mapped(raw, mergedFields, "severity")),
    priority: numericOrText(mapped(raw, mergedFields, "priority")),
    affectedVersion: printableValue(
      mapped(raw, mergedFields, "affectedVersion"),
    ).trim(),
    resolvedVersion: printableValue(
      mapped(raw, mergedFields, "resolvedVersion"),
    ).trim(),
    product: printableValue(mapped(raw, mergedFields, "product")).trim(),
    project: printableValue(mapped(raw, mergedFields, "project")).trim(),
    execution: printableValue(mapped(raw, mergedFields, "execution")).trim(),
    executionName: printableValue(mapped(raw, mergedFields, "executionName")).trim(),
    module: printableValue(mapped(raw, mergedFields, "module")).trim(),
    status: printableValue(mapped(raw, mergedFields, "status")).trim(),
    assignee: printableValue(mapped(raw, mergedFields, "assignee")).trim(),
    url: printableValue(mapped(raw, mergedFields, "url")).trim(),
    attachments: mergeAttachments(explicitAttachments, inlineAttachments),
    comments,
    repositoryProject: repositoryProject.name,
    repositoryProjectSource: repositoryProject.source,
    repositoryProjectLabel: repositoryProject.label,
    fetchStatus: raw.__fetchStatus || "complete",
    ...(raw.__fetchError ? { fetchError: raw.__fetchError } : {}),
  };
}

export function normalizeAndFilterBugs(rawBugs, config) {
  const closed = new Set(
    config.policy.closedStatuses.map((status) => String(status).toLocaleLowerCase()),
  );
  const currentUser = config.currentUser.toLocaleLowerCase();
  const seen = new Set();

  return rawBugs
    .map((raw) => normalizeBug(raw, config.source.fields, {
      baseUrl: config.source.baseUrl,
    }))
    .filter((bug) => {
      if (!bug.id || seen.has(bug.id)) return false;
      seen.add(bug.id);
      if (closed.has(bug.status.toLocaleLowerCase())) return false;
      if (
        config.source.filterAssignedToCurrentUser !== false &&
        bug.assignee &&
        bug.assignee.toLocaleLowerCase() !== currentUser
      ) {
        return false;
      }
      return true;
    });
}
