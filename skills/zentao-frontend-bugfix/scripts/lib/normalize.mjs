import { getByPath, printableValue, stripHtml } from "./utils.mjs";

const DEFAULT_FIELDS = {
  id: "id",
  title: "title",
  description: "description",
  steps: "steps",
  severity: "severity",
  priority: "priority",
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

export function normalizeBug(raw, fields = {}) {
  const mergedFields = { ...DEFAULT_FIELDS, ...fields };
  const id = printableValue(mapped(raw, mergedFields, "id")).trim();
  return {
    id,
    title: stripHtml(mapped(raw, mergedFields, "title")),
    description: stripHtml(mapped(raw, mergedFields, "description")),
    steps: stripHtml(mapped(raw, mergedFields, "steps")),
    severity: numericOrText(mapped(raw, mergedFields, "severity")),
    priority: numericOrText(mapped(raw, mergedFields, "priority")),
    product: printableValue(mapped(raw, mergedFields, "product")).trim(),
    project: printableValue(mapped(raw, mergedFields, "project")).trim(),
    execution: printableValue(mapped(raw, mergedFields, "execution")).trim(),
    executionName: printableValue(mapped(raw, mergedFields, "executionName")).trim(),
    module: printableValue(mapped(raw, mergedFields, "module")).trim(),
    status: printableValue(mapped(raw, mergedFields, "status")).trim(),
    assignee: printableValue(mapped(raw, mergedFields, "assignee")).trim(),
    url: printableValue(mapped(raw, mergedFields, "url")).trim(),
    attachments: mapped(raw, mergedFields, "attachments") ?? [],
    comments: mapped(raw, mergedFields, "comments") ?? [],
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
