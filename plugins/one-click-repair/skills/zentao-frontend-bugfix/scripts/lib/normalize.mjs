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

export function normalizeBug(raw, fields = {}) {
  const mergedFields = { ...DEFAULT_FIELDS, ...fields };
  const id = printableValue(mapped(raw, mergedFields, "id")).trim();
  const comments = mapped(raw, mergedFields, "comments") ?? [];
  const title = stripHtml(mapped(raw, mergedFields, "title"));
  const description = stripHtml(mapped(raw, mergedFields, "description"));
  const steps = stripHtml(mapped(raw, mergedFields, "steps"));
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
    attachments: mapped(raw, mergedFields, "attachments") ?? [],
    comments,
    repositoryProject: repositoryProject.name,
    repositoryProjectSource: repositoryProject.source,
    repositoryProjectLabel: repositoryProject.label,
  };
}

export function normalizeAndFilterBugs(rawBugs, config) {
  const closed = new Set(
    config.policy.closedStatuses.map((status) => String(status).toLocaleLowerCase()),
  );
  const currentUser = config.currentUser.toLocaleLowerCase();
  const seen = new Set();

  return rawBugs
    .map((raw) => normalizeBug(raw, config.source.fields))
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
