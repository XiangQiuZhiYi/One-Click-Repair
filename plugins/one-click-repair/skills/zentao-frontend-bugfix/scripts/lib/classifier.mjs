const CATEGORY_RULES = [
  {
    category: "REQUIREMENT",
    keywords: ["缺少需求", "需求"],
  },
  {
    category: "COPY",
    keywords: ["文案", "错别字", "拼写", "文字", "翻译", "label", "placeholder"],
  },
  {
    category: "STYLE",
    keywords: [
      "样式",
      "布局",
      "错位",
      "溢出",
      "遮挡",
      "间距",
      "颜色",
      "响应式",
      "z-index",
      "css",
    ],
  },
  {
    category: "FORM_VALIDATION",
    keywords: ["校验", "必填", "表单", "输入框", "validation", "validator"],
  },
  {
    category: "NULL_GUARD",
    keywords: ["空指针", "undefined", "null", "cannot read", "未定义", "白屏"],
  },
  {
    category: "API_MAPPING",
    keywords: ["接口字段", "字段映射", "返回字段", "response", "枚举映射", "接口数据"],
  },
  {
    category: "BUILD",
    keywords: [
      "编译",
      "构建",
      "打包",
      "类型错误",
      "module not found",
      "typescript",
      "import",
    ],
  },
  {
    category: "COMPATIBILITY",
    keywords: ["兼容", "safari", "chrome", "firefox", "浏览器", "移动端"],
  },
  {
    category: "PERFORMANCE",
    keywords: ["性能", "卡顿", "缓慢", "内存", "首屏", "加载慢"],
  },
  {
    category: "STATE_LOGIC",
    keywords: ["状态", "切换", "刷新", "缓存", "回显", "禁用", "启用", "流程"],
  },
];

const DEFAULT_HIGH_RISK_KEYWORDS = [
  "鉴权",
  "权限模型",
  "安全",
  "支付",
  "加密",
  "后端",
  "数据库",
  "数据迁移",
  "大版本",
  "重构",
  "架构",
  "全局",
  "公共组件",
];

function contains(text, keyword) {
  return text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
}

function contextText(bug) {
  return `${bug.title}\n${bug.description}\n${bug.steps}\n${JSON.stringify(bug.comments ?? [])}`;
}

function detectUserHandling(text) {
  if (/状态(?:<[^>]+>|\s)*[:：](?:<[^>]+>|\s)*(?:待确认|需确认|需要确认)/i.test(text)) {
    return "NEED_CONFIRM";
  }
  if (/状态(?:<[^>]+>|\s)*[:：](?:<[^>]+>|\s)*(?:直接处理|可处理|无需确认)/i.test(text)) {
    return "AUTO_FIX";
  }
  return undefined;
}

export function detectCategory(bug) {
  const text = contextText(bug);
  let best = { category: "UNKNOWN", hits: [], confidence: 0.35 };

  for (const rule of CATEGORY_RULES) {
    const hits = rule.keywords.filter((keyword) => contains(text, keyword));
    if (hits.length > best.hits.length) {
      best = {
        category: rule.category,
        hits,
        confidence: Math.min(0.95, 0.68 + hits.length * 0.09),
      };
    }
  }
  return best;
}

function isDetailedEnough(bug, category) {
  const comments = JSON.stringify(bug.comments ?? []);
  const detailLength = `${bug.description}${bug.steps}${comments}`.trim().length;
  const hasExpectedBehavior = /应|期望|预期|改为|显示为|should|expected/i.test(
    `${bug.title}\n${bug.description}\n${comments}`,
  );
  if (["COPY", "STYLE"].includes(category)) {
    return detailLength >= 16 && hasExpectedBehavior;
  }
  return detailLength >= 30 && bug.steps.length >= 8;
}

export function classifyBug(bug, repository, policy) {
  const detected = detectCategory(bug);
  const text = contextText(bug);
  const userHandling = detectUserHandling(text);
  const riskKeywords = [...DEFAULT_HIGH_RISK_KEYWORDS, ...(policy.highRiskKeywords ?? [])].filter(
    (keyword, index, all) => all.indexOf(keyword) === index && contains(text, keyword),
  );
  const reasons = [
    detected.hits.length
      ? `命中 ${detected.category} 关键词：${detected.hits.join("、")}`
      : "未命中明确的前端问题类型规则",
  ];
  const questions = [];
  let decision;

  if (!repository) {
    decision = "BLOCKED";
    if (!bug.repositoryProject) {
      reasons.push("禅道评论中缺少“所属项目：XXX”标记");
      questions.push("请先在该 Bug 的禅道评论中备注“所属项目：XXX”，然后重新执行一键禅道。");
    } else {
      reasons.push(`所属项目“${bug.repositoryProject}”没有匹配到本地代码仓库`);
      questions.push(`项目“${bug.repositoryProject}”对应哪个当前本地仓库绝对路径？`);
    }
  } else if (repository.available === false) {
    decision = "BLOCKED";
    reasons.push(repository.blocker || "本地代码仓库不可用");
    questions.push("请确认当前仓库目录路径和读写权限。");
  } else if (!bug.title || !bug.description) {
    decision = "NEED_CONFIRM";
    reasons.push("标题或问题描述缺失");
    questions.push("请补充实际表现、预期表现和稳定复现步骤。");
  } else if (riskKeywords.length > 0) {
    decision = "HUMAN_REQUIRED";
    reasons.push(`命中高风险关键词：${riskKeywords.join("、")}`);
  } else if (
    typeof bug.severity === "number" &&
    bug.severity <= policy.humanReviewSeverityAtOrBelow
  ) {
    decision = "HUMAN_REQUIRED";
    reasons.push(`严重程度 ${bug.severity} 达到强制人工复核阈值`);
  } else if (userHandling === "NEED_CONFIRM") {
    decision = "NEED_CONFIRM";
    reasons.push("禅道备注已标记为待确认");
    questions.push("请确认会改变实现方向的业务规则或交互预期。");
  } else if (userHandling === "AUTO_FIX" && isDetailedEnough(bug, detected.category)) {
    decision = "AUTO_FIX";
    reasons.push("禅道备注已明确标记为直接处理，且描述足以确定修改方向");
  } else if ((policy.humanRequiredCategories ?? []).includes(detected.category)) {
    decision = "HUMAN_REQUIRED";
    reasons.push(`${detected.category} 默认需要人工评估影响范围`);
  } else if (detected.category === "UNKNOWN") {
    decision = "NEED_CONFIRM";
    reasons.push("无法从现有信息判断稳定的修复方向");
    questions.push("请补充复现步骤、预期结果、实际结果以及相关截图或控制台错误。");
  } else if (!isDetailedEnough(bug, detected.category)) {
    decision = "NEED_CONFIRM";
    reasons.push("现有信息不足以验证修改是否符合预期");
    questions.push("请补充稳定复现步骤，以及修改前后的明确预期。");
  } else if (detected.confidence < policy.minAutoFixConfidence) {
    decision = "NEED_CONFIRM";
    reasons.push(
      `分类置信度 ${detected.confidence.toFixed(2)} 低于自动修复阈值 ${policy.minAutoFixConfidence}`,
    );
    questions.push("请确认问题类型和期望修改范围。");
  } else if ((policy.autoFixCategories ?? []).includes(detected.category)) {
    decision = "AUTO_FIX";
    reasons.push("问题类型在自动修复白名单内，且未触发风险门禁");
  } else {
    decision = "HUMAN_REQUIRED";
    reasons.push(`${detected.category} 不在自动修复白名单内`);
  }

  return {
    category: detected.category,
    decision,
    confidence: Number(detected.confidence.toFixed(2)),
    reasons,
    questions,
    nextAction: {
      AUTO_FIX: "加入可直接修改清单，等待用户明确回复“确认修改”",
      NEED_CONFIRM: "获得问题答案后补充 Bug 信息并重新分诊",
      HUMAN_REQUIRED: "由人工确认方案、影响范围和负责人",
      BLOCKED: "询问该项目当前仓库目录，保存映射后重新分诊",
    }[decision],
  };
}
