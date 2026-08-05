# One-Click-Repair

通过 Codex Plugin 在聊天中拉取、分析并处理禅道前端 Bug。

Plugin 由两部分组成：

- 本地 MCP Server：连接禅道、自动刷新 Token、生成报告并保存“代码仓库名称 → 本地仓库”；
- Codex Skill：逐条语义分析 Bug、接受聊天补充、展示清单，并在用户明确授权后修改。

MCP 不负责直接修改业务代码。真正的代码修改仍由 Codex 在用户提供的当前仓库中完成。

完整的端到端流程、每个环节的职责、失败处理和安全边界见
[One-Click-Repair 完整工作流程](docs/complete-workflow.md)。

## 使用要求

- macOS（密码保存在系统钥匙串）
- Node.js 20 或更高版本
- Codex 桌面版、Codex VS Code 扩展或 Codex CLI
- 禅道开源版 21.6，并且当前账号可以访问 REST API v1

## 首次安装

推荐使用 npm 一键安装器：

```bash
npx one-click-repair@latest setup
```

命令会交互询问禅道地址、账号和密码。也可以提前传入地址：

```bash
npx one-click-repair@latest setup --base-url https://你的禅道地址/zentao
```

如果从源码开发或 npm 包尚未发布，也可以执行：

```bash
git clone https://github.com/XiangQiuZhiYi/One-Click-Repair.git
cd One-Click-Repair
npm install
npm run bootstrap -- --base-url https://你的禅道地址/zentao
```

初始化命令会完成：

1. 自动发现终端 PATH、Codex Desktop 或 VS Code Codex 扩展内置的 CLI；
2. 将 Plugin 复制到 `~/.codex/one-click-repair/marketplace` 稳定目录；
3. 添加 `one-click-repair` Codex Marketplace；
4. 安装或更新 `one-click-repair` Plugin；
5. 在 Codex 用户目录生成本地配置；
6. 询问禅道登录账号；
7. 通过 macOS 钥匙串安全询问并保存密码；
8. 登录禅道并生成短期 Token；
9. 迁移并备份以前手动安装的同名 Skill，避免重复触发。

密码不会写入项目、配置、日志、MCP 返回值或 Git。初始化成功后，请完全退出并重新
打开 Codex，以加载新的 Skill 和 MCP 工具。

如果 Codex 安装在自定义位置且初始化器无法自动发现，可指定 CLI 路径后重试：

```bash
CODEX_CLI_PATH="/自定义位置/codex" npx one-click-repair@latest setup
```

初始化器会检查 VS Code、VS Code Insiders、Cursor、Windsurf 和 VSCodium 的
`openai.chatgpt` 扩展目录，因此只安装 IDE 扩展的用户也不需要单独安装全局 CLI。

## 日常使用

在 Codex 聊天中输入：

```text
执行一键禅道
```

之后不需要再执行命令行。Codex 会：

1. 直接读取禅道“指派给我”的个人 Bug 列表，只为命中项补拉详情；不会扫描开发者无关的产品和 Bug；
2. 逐条整合描述、复现步骤、评论、所属项目、所属执行和影响版本等信息；
3. 按摘要分页读取、本地按需获取详情，并持久化核心问题、逻辑/样式/需求类型和确认点；
4. 展示“可直接修改、等待确认、人工处理、仓库待配置”完整清单；
5. 按需安全查看同源的 PNG、JPEG、WebP 或 GIF Bug 截图；
6. 从评论、描述和复现步骤中的多种代码仓库字段识别项目；
7. 第一次遇到某个项目时询问当前本地仓库绝对路径并保存，然后基于现有报告在本地
   刷新最终清单，不重新请求禅道；后续自动复用；
8. 等待用户用自然语言明确授权修改；
9. 只修改最终清单中的可直接修改项，并做代码逻辑复核。

首次发送“执行一键禅道”“处理这些 Bug”只会触发预览。预览完成后，用户可以说
“确认修改”“改吧”“修复 Bug #90001”等明确表达。用户直接针对具体 Bug 给出修改
方案也同时视为授权，例如“#90002 将默认页大小改为 20，并保留用户已选值”。
Codex 保存补充后立即修改，不得再索要一次确认。

## MCP 工具

Plugin 提供以下本地工具：

- `zentao_auth_status`：检查配置和认证状态，不返回凭据内容；
- `zentao_list_my_bugs`：直接拉取个人“指派给我”的未关闭 Bug，支持精简分页摘要、阶段进度、请求与耗时统计，并生成安全报告；
- `zentao_get_bug_detail`：优先从本地报告读取单个 Bug，按需只刷新该 Bug；
- `zentao_get_bug_attachment`：按需读取 `files` 或描述、步骤、评论内联图片中声明的同源截图，不落盘；
- `bug_record_analyses`：批量持久化 Codex 的语义分析，不回写禅道；
- `repository_get_by_project`：按代码仓库名称或唯一简称查询已保存的本地仓库；
- `repository_set_by_project`：验证并按项目保存用户提供的仓库目录，同时基于现有
  报告本地刷新仓库状态和预分诊结果；
- `bug_apply_user_supplement`：将聊天中补充的仓库、类型和确认信息写入本地报告；
- `workspace_select_for_bug`：用户确认修改或给出具体修改方案后返回该 Bug 的修改
  目录；`NEED_CONFIRM`、`HUMAN_REQUIRED` 可由这次人工授权解锁，`BLOCKED` 不可绕过。

Plugin 不提供 `fix_bug`、Git、部署或禅道回写工具。

## 安全规则

- 修改前必须展示预览；用户确认修改或直接给出具体修改方案都算授权，不能重复确认；
- Skill、README、测试和 npm 包只允许使用虚构 Bug 与 `example-*` 仓库示例；真实 Bug
  ID、标题、业务常量和仓库名只保存在用户本机的运行报告中，不得写回分发源码；
- 不在聊天中索取或显示账号、密码及 Token；
- 不创建 worktree，不执行任何 Git 命令；
- 直接使用用户已经准备好的当前仓库目录；
- 修改业务项目后不运行其 `script`、lint、test、typecheck 或 build；
- 只进行代码逻辑复核，并明确保留运行时验收风险；
- 默认不修改禅道状态、不评论、不部署。

禅道备注可以使用以下简短格式帮助分诊：

```text
问题代码仓库：example-react
类型：逻辑 / 样式 / 需求 / 缺少需求
状态：直接处理 / 可处理 / 待确认
```

仓库字段兼容 `问题代码仓库`、`代码仓库`、`所属仓库`、`所属项目` 等写法，用于
区分同一所属执行下的 `example-react`、`example-vue` 等代码项目。未填写时也可直接在聊天中
补充。禅道中的“状态：直接处理”不等于聊天中的修改授权。

## 本地数据位置

默认保存在：

```text
~/.codex/zentao-frontend-bugfix/config.json
~/.codex/zentao-frontend-bugfix/secrets/
~/.codex/zentao-frontend-bugfix/output/
```

如果设置了 `CODEX_HOME`，则保存在 `$CODEX_HOME/zentao-frontend-bugfix/`。

- `config.json`：禅道地址和“代码仓库名称 → 仓库目录”映射；
- `secrets/zentao-account`：账号，文件权限为 `0600`；
- `secrets/zentao-token`：短期 Token，文件权限为 `0600`；
- `output/`：目录权限为 `0700`，报告和工作区元数据为 `0600`；
- 密码：只存在 macOS 钥匙串。

这些运行数据不属于 Plugin/npm 包内容，也不会因为安装或升级被上传。公开仓库中的
示例统一使用虚构编号和 `example-*` 名称。完整刷新后会移除已经不在当前清单中的旧
Bug Markdown 明细。

## 更新

使用 npm 安装的用户：

```bash
npx one-click-repair@latest update
```

从源码安装的用户：

```bash
cd One-Click-Repair
git pull
npm install
npm run install-plugin
```

更新后完全退出并重新打开 Codex。用户配置、Token、钥匙串密码和仓库映射不会被覆盖。

如果禅道地址、账号或密码发生变化，重新运行：

```bash
npx one-click-repair@latest setup --base-url https://你的禅道地址/zentao
```

## 开发与验证

```bash
npm run build:mcp
npm test
npm run bugfix -- doctor
npm run cli -- doctor
npm run pack:check
```

- `build:mcp` 将 MCP Server 和运行依赖打包为 Plugin 内的单文件；
- `npm test` 只测试 One-Click-Repair 本身，不会访问真实禅道；
- `doctor` 只检查配置、认证文件和已保存的仓库目录，不修改业务项目。
- `pack:check` 检查准备发布到 npm 的文件，不执行发布。

仓库中的 `.agents/plugins/marketplace.json` 是团队分发入口，实际 Plugin 位于
`plugins/one-click-repair/`。
