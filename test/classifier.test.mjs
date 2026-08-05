import assert from "node:assert/strict";
import test from "node:test";
import { classifyBug } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/classifier.mjs";

const policy = {
  autoFixCategories: ["STYLE", "COPY", "FORM_VALIDATION", "NULL_GUARD", "API_MAPPING", "BUILD"],
  humanRequiredCategories: ["STATE_LOGIC", "COMPATIBILITY", "PERFORMANCE"],
  minAutoFixConfidence: 0.75,
  humanReviewSeverityAtOrBelow: 1,
  highRiskKeywords: [],
};

const repository = {
  name: "web",
  repoPath: "/tmp/web",
  projectKey: "web",
  projectName: "web",
};

test("明确的低风险文案问题进入 AUTO_FIX", () => {
  const result = classifyBug(
    {
      id: "1",
      title: "登录按钮文案拼写错误",
      description: "登录页按钮现在显示为“登 录录”，预期应显示为“登录”。",
      steps: "打开登录页面即可看到错误文案。",
      severity: 3,
    },
    repository,
    policy,
  );
  assert.equal(result.category, "COPY");
  assert.equal(result.decision, "AUTO_FIX");
  assert.ok(result.confidence >= 0.75);
});

test("信息不足的问题进入 NEED_CONFIRM", () => {
  const result = classifyBug(
    {
      id: "2",
      title: "页面偶发异常",
      description: "有时不对。",
      steps: "",
      severity: 3,
    },
    repository,
    policy,
  );
  assert.equal(result.decision, "NEED_CONFIRM");
  assert.ok(result.questions.length > 0);
});

test("鉴权和跨后端问题进入 HUMAN_REQUIRED", () => {
  const result = classifyBug(
    {
      id: "3",
      title: "重新设计鉴权状态",
      description: "需要调整权限模型，并同步修改后端鉴权接口。",
      steps: "登录后进入任意受限页面可以复现。",
      severity: 1,
    },
    repository,
    policy,
  );
  assert.equal(result.decision, "HUMAN_REQUIRED");
  assert.match(result.reasons.join("\n"), /高风险|严重程度/);
});

test("没有仓库映射时进入 BLOCKED", () => {
  const result = classifyBug(
    {
      id: "4",
      title: "按钮文案拼写错误",
      description: "按钮显示为错误文字，预期应显示为保存。",
      steps: "打开编辑页面即可看到。",
      severity: 3,
      repositoryProject: "web",
    },
    undefined,
    policy,
  );
  assert.equal(result.decision, "BLOCKED");
  assert.match(result.questions.join("\n"), /“web”对应哪个当前本地仓库/);
});

test("缺少仓库线索时允许用户直接在聊天中补充", () => {
  const result = classifyBug(
    {
      id: "missing-project",
      title: "按钮文案拼写错误",
      description: "按钮显示为错误文字，预期应显示为保存。",
      steps: "打开编辑页面即可看到。",
      severity: 3,
      repositoryProject: "",
    },
    undefined,
    policy,
  );
  assert.equal(result.decision, "BLOCKED");
  assert.match(result.questions.join("\n"), /无需先回写禅道/);
});

test("评论中的明确预期参与分类", () => {
  const result = classifyBug(
    {
      id: "5",
      title: "按钮有问题",
      description: "详情见评论。",
      steps: "",
      comments: [
        {
          author: "tester",
          content: "这是按钮文案拼写问题，当前为“保 存存”，预期应显示为“保存”。",
        },
      ],
      severity: 3,
    },
    repository,
    policy,
  );
  assert.equal(result.category, "COPY");
  assert.equal(result.decision, "AUTO_FIX");
});

test("禅道备注中的缺少需求和直接处理进入 AUTO_FIX", () => {
  const result = classifyBug(
    {
      id: "6",
      title: "老师列缺少说明",
      description: "老师列缺少问号提示，期望 hover 后显示老师的真实姓名。",
      steps: "进入课时统计的老师课程页面，查看表格老师列。",
      comments: [
        {
          comment: "<p>类型：缺少需求</p><p>状态：直接处理</p>",
        },
      ],
      severity: 4,
    },
    repository,
    policy,
  );
  assert.equal(result.category, "REQUIREMENT");
  assert.equal(result.decision, "AUTO_FIX");
  assert.match(result.reasons.join("\n"), /直接处理/);
});

test("禅道备注标记待确认时不会自动修改", () => {
  const result = classifyBug(
    {
      id: "7",
      title: "列表增加操作入口",
      description: "列表需要增加操作入口，入口位置和权限范围尚未明确。",
      steps: "进入列表页面，查看操作列。",
      comments: [
        {
          comment: "<p>类型：需求</p><p>状态：待确认</p>",
        },
      ],
      severity: 4,
    },
    repository,
    policy,
  );
  assert.equal(result.category, "REQUIREMENT");
  assert.equal(result.decision, "NEED_CONFIRM");
});

test("聊天补充可以纠正问题类型并解除已回答的确认点", () => {
  const result = classifyBug(
    {
      id: "8",
      title: "老师姓名显示异常",
      description: "详情标题当前多显示分隔符，用户已明确只保留实际存在的名称。",
      steps: "进入课时统计页面查看详情标题。",
      comments: [{ comment: "<p>状态：待确认</p>" }],
      userSupplement: {
        problemType: "逻辑",
        needsConfirmation: false,
        note: "英文名为空时不显示分隔符。",
      },
      severity: 3,
    },
    repository,
    policy,
  );
  assert.equal(result.category, "STATE_LOGIC");
  assert.equal(result.decision, "AUTO_FIX");
  assert.match(result.reasons.join("\n"), /用户已在聊天中补充/);
});

test("Codex 语义分析可以提出确认点但不能绕过高风险与客观阻塞", () => {
  const baseBug = {
    id: "semantic",
    title: "页面行为需要调整",
    description: "页面行为与预期不一致，需要根据规则调整。",
    steps: "打开页面并执行操作。",
    severity: 3,
  };
  const confirmation = classifyBug(baseBug, repository, policy, {
    problemType: "逻辑",
    needsConfirmation: true,
    confirmationQuestion: "是否立即刷新？",
    risk: "medium",
  });
  assert.equal(confirmation.decision, "NEED_CONFIRM");
  assert.match(confirmation.questions.join("\n"), /是否立即刷新/);

  const highRisk = classifyBug(baseBug, repository, policy, {
    problemType: "样式",
    needsConfirmation: false,
    risk: "high",
  });
  assert.equal(highRisk.decision, "HUMAN_REQUIRED");

  const blocked = classifyBug(baseBug, undefined, policy, {
    problemType: "样式",
    needsConfirmation: false,
    risk: "low",
  });
  assert.equal(blocked.decision, "BLOCKED");
});
