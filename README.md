# One-Click-Repair

在 Codex 聊天中拉取、分析并处理禅道前端 Bug。Codex 会先展示完整分诊清单，按禅道
“所属执行”复用本地仓库目录，并且只有在用户回复“确认修改”后才修改代码。

## 使用要求

- macOS（密码保存在系统钥匙串）
- Node.js 20 或更高版本
- Codex 桌面版或 Codex CLI
- 能访问禅道开源版 21.6 REST API

不需要执行 `npm install`，项目没有第三方运行依赖。

## 首次安装

```bash
git clone https://github.com/XiangQiuZhiYi/One-Click-Repair.git
cd One-Click-Repair
npm run bootstrap -- --base-url https://你的禅道地址/zentao
```

初始化命令会依次完成：

1. 将 `zentao-frontend-bugfix` 安装到 Codex Skill 目录；
2. 在 Codex 用户目录生成本地配置；
3. 询问禅道登录账号；
4. 通过 macOS 钥匙串安全询问并保存密码；
5. 登录禅道并生成短期 Token。

密码不会写入项目、配置、日志或 Git。初始化成功后，完全退出并重新打开 Codex，让
Codex 重新加载 Skill。

## 在 Codex 中使用

打开一个 Codex 聊天，直接输入：

```text
执行一键禅道
```

Codex 会：

1. 拉取指派给当前账号且未关闭的 Bug；
2. 逐条分析核心问题、逻辑/样式/需求类型和待确认点；
3. 展示“可直接修改、等待确认、人工处理、仓库待配置”清单；
4. 第一次遇到某个“所属执行”时询问当前本地仓库绝对路径；
5. 保存“所属执行 ID → 仓库目录”，以后自动复用；
6. 等待用户明确回复 `确认修改`；
7. 修改代码并只做代码逻辑复核，不运行项目 script 或 Git 命令。

禅道备注可使用以下简短格式帮助分诊：

```text
类型：逻辑 / 样式 / 需求 / 缺少需求
状态：直接处理 / 可处理 / 待确认
```

禅道中的“状态：直接处理”不等于聊天授权。Codex 仍会先展示清单，并等待用户回复
`确认修改`。

## 本地数据位置

默认保存在：

```text
~/.codex/zentao-frontend-bugfix/config.json
~/.codex/zentao-frontend-bugfix/secrets/
~/.codex/zentao-frontend-bugfix/output/
```

如果设置了 `CODEX_HOME`，则保存在 `$CODEX_HOME/zentao-frontend-bugfix/`。

- `config.json`：禅道地址和“所属执行 → 仓库目录”映射；
- `secrets/zentao-account`：账号，文件权限为 `0600`；
- `secrets/zentao-token`：短期 Token，文件权限为 `0600`；
- 密码：只存在 macOS 钥匙串。

## 更新

```bash
cd One-Click-Repair
git pull
npm run install-skill
```

更新完成后重新启动 Codex。该命令只更新 Skill，不覆盖用户配置、Token 或仓库映射。

如果禅道地址、账号或密码发生变化，重新运行：

```bash
npm run bootstrap -- --base-url https://你的禅道地址/zentao
```

## 自检

```bash
npm run bugfix -- doctor
```

自检只检查配置、认证文件和已保存的仓库目录，不请求禅道、不修改业务项目，也不运行
业务项目脚本。
