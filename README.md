# One-Click-Repair

通过 Codex Plugin 在聊天中拉取、分析并处理禅道前端 Bug。

Plugin 由两部分组成：

- 本地 MCP Server：连接禅道、自动刷新 Token、生成报告并保存“评论所属项目 → 本地仓库”；
- Codex Skill：逐条语义分析 Bug、展示修改清单，并严格等待用户回复 `确认修改`。

MCP 不负责直接修改业务代码。真正的代码修改仍由 Codex 在用户提供的当前仓库中完成。

## 使用要求

- macOS（密码保存在系统钥匙串）
- Node.js 20 或更高版本
- Codex 桌面版、Codex VS Code 扩展或 Codex CLI
- 禅道开源版 21.6，并且当前账号可以访问 REST API v1

## 首次安装

```bash
git clone https://github.com/XiangQiuZhiYi/One-Click-Repair.git
cd One-Click-Repair
npm install
npm run bootstrap -- --base-url https://你的禅道地址/zentao
```

初始化命令会完成：

1. 自动发现终端 PATH、Codex Desktop 或 VS Code Codex 扩展内置的 CLI；
2. 添加仓库内的 `one-click-repair` Codex Marketplace；
3. 安装或更新 `one-click-repair` Plugin；
4. 在 Codex 用户目录生成本地配置；
5. 询问禅道登录账号；
6. 通过 macOS 钥匙串安全询问并保存密码；
7. 登录禅道并生成短期 Token；
8. 迁移并备份以前手动安装的同名 Skill，避免重复触发。

密码不会写入项目、配置、日志、MCP 返回值或 Git。初始化成功后，请完全退出并重新
打开 Codex，以加载新的 Skill 和 MCP 工具。

如果 Codex 安装在自定义位置且初始化器无法自动发现，可指定 CLI 路径后重试：

```bash
CODEX_CLI_PATH="/自定义位置/codex" npm run bootstrap
```

初始化器会检查 VS Code、VS Code Insiders、Cursor、Windsurf 和 VSCodium 的
`openai.chatgpt` 扩展目录，因此只安装 IDE 扩展的用户也不需要单独安装全局 CLI。

## 日常使用

在 Codex 聊天中输入：

```text
执行一键禅道
```

之后不需要再执行命令行。Codex 会：

1. 通过 MCP 拉取指派给当前账号且未关闭的 Bug；
2. 逐条整合描述、复现步骤、评论、所属项目、所属执行和影响版本等信息；
3. 判断核心问题、逻辑/样式/需求类型和需要确认的实现分歧；
4. 展示“可直接修改、等待确认、人工处理、仓库待配置”完整清单；
5. 从评论中的 `所属项目：XXX` 识别代码项目；
6. 第一次遇到某个项目时询问当前本地仓库绝对路径并保存，然后基于现有报告在本地
   刷新最终清单，不重新请求禅道；后续自动复用；
7. 等待用户明确回复 `确认修改`；
8. 只修改最终清单中的可直接修改项，并做代码逻辑复核。

“执行一键禅道”“处理这些 Bug”“可以处理”只会触发预览。只有最终清单展示完成后，
用户明确回复 `确认修改` 才会进入代码修改阶段。

## MCP 工具

Plugin 提供以下本地工具：

- `zentao_auth_status`：检查配置和认证状态，不返回凭据内容；
- `zentao_list_my_bugs`：拉取全部个人未关闭 Bug，并生成结构化报告；
- `zentao_get_bug_detail`：按 Bug ID 获取完整上下文；
- `repository_get_by_project`：查询评论所属项目对应的本地仓库；
- `repository_set_by_project`：验证并按项目保存用户提供的仓库目录，同时基于现有
  报告本地刷新仓库状态和预分诊结果；
- `workspace_select_for_bug`：仅在用户确认后返回该 Bug 的修改目录。

Plugin 不提供 `fix_bug`、Git、部署或禅道回写工具。

## 安全规则

- 修改前必须展示最终清单并等待 `确认修改`；
- 不在聊天中索取或显示账号、密码及 Token；
- 不创建 worktree，不执行任何 Git 命令；
- 直接使用用户已经准备好的当前仓库目录；
- 修改业务项目后不运行其 `script`、lint、test、typecheck 或 build；
- 只进行代码逻辑复核，并明确保留运行时验收风险；
- 默认不修改禅道状态、不评论、不部署。

禅道备注可以使用以下简短格式帮助分诊：

```text
所属项目：sisreact
类型：逻辑 / 样式 / 需求 / 缺少需求
状态：直接处理 / 可处理 / 待确认
```

`所属项目` 用于区分同一所属执行下的 `sisreact`、`sisvue` 等代码项目。禅道中的
“状态：直接处理”不等于聊天中的修改授权。

## 本地数据位置

默认保存在：

```text
~/.codex/zentao-frontend-bugfix/config.json
~/.codex/zentao-frontend-bugfix/secrets/
~/.codex/zentao-frontend-bugfix/output/
```

如果设置了 `CODEX_HOME`，则保存在 `$CODEX_HOME/zentao-frontend-bugfix/`。

- `config.json`：禅道地址和“评论所属项目 → 仓库目录”映射；
- `secrets/zentao-account`：账号，文件权限为 `0600`；
- `secrets/zentao-token`：短期 Token，文件权限为 `0600`；
- 密码：只存在 macOS 钥匙串。

## 更新

```bash
cd One-Click-Repair
git pull
npm install
npm run install-plugin
```

更新后完全退出并重新打开 Codex。用户配置、Token、钥匙串密码和仓库映射不会被覆盖。

如果禅道地址、账号或密码发生变化，重新运行：

```bash
npm run bootstrap -- --base-url https://你的禅道地址/zentao
```

## 开发与验证

```bash
npm run build:mcp
npm test
npm run bugfix -- doctor
```

- `build:mcp` 将 MCP Server 和运行依赖打包为 Plugin 内的单文件；
- `npm test` 只测试 One-Click-Repair 本身，不会访问真实禅道；
- `doctor` 只检查配置、认证文件和已保存的仓库目录，不修改业务项目。

仓库中的 `.agents/plugins/marketplace.json` 是团队分发入口，实际 Plugin 位于
`plugins/one-click-repair/`。
