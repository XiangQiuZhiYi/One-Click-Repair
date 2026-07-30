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

export function extractRepositoryProject(comments = []) {
  const items = Array.isArray(comments) ? comments : [comments];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = commentText(items[index]);
    const match = text.match(/(?:所属|属于)项目\s*[:：]\s*([^\r\n]+)/iu);
    if (match?.[1]) {
      return match[1].trim().replace(/[。；;，,]+$/u, "").trim();
    }
  }
  return "";
}

export function normalizeBug(raw, fields = {}) {
  const mergedFields = { ...DEFAULT_FIELDS, ...fields };
  const id = printableValue(mapped(raw, mergedFields, "id")).trim();
  const comments = mapped(raw, mergedFields, "comments") ?? [];
  return {
    id,
    title: stripHtml(mapped(raw, mergedFields, "title")),
    description: stripHtml(mapped(raw, mergedFields, "description")),
    steps: stripHtml(mapped(raw, mergedFields, "steps")),
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
    repositoryProject: extractRepositoryProject(comments),
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
