# 配置参考

## 路径规则

- 配置中的相对路径以配置文件所在目录为基准。
- `repoPath` 推荐使用绝对路径。
- `outputDir` 保存分诊报告和工作区元数据。

## 数据源

### 禅道开源版 21.6

优先使用内置的“个人列表 + REST API v1 详情”适配器：

```json
{
  "source": {
    "type": "zentao-v1",
    "baseUrl": "https://zentao.example.com",
    "tokenEnv": "ZENTAO_TOKEN",
    "tokenFile": "./secrets/zentao-token",
    "accountFile": "./secrets/zentao-account",
    "personalBugListMode": "assigned-to-me",
    "personalBugListPath": "my-work-bug-assignedTo--id_desc.html",
    "personalBugPageSize": 100,
    "maxPersonalBugPages": 20,
    "detailConcurrency": 4
  }
}
```

`currentUser` 可以省略，执行器会读取初始化时保存的账号文件；也可以显式填写。

执行器会依次请求：

1. 使用钥匙串凭据建立临时 Web Session；
2. 读取个人“指派给我”页面及其必要分页；
3. 仅对该列表中指派给当前账号且未关闭的 Bug 请求 `GET /api.php/v1/bugs/{bugID}`。

默认不会请求产品列表或其他人的 Bug。Web Session Cookie 和密码只存在于本次调用内存
中。报告会保存拉取模式、候选数量、详情请求数、重试数和各阶段耗时，不保存 Cookie、
密码、Token、响应正文或敏感 URL 查询参数。

如果禅道安装在子路径下，`baseUrl` 包含子路径，例如
`https://example.com/zentao`。如果直接填写以 `/api.php/v1` 结尾的地址也可以。

如果实例定制了个人列表页面而不兼容安全解析器，可以显式启用旧兼容路径：

```json
{
  "source": {
    "personalBugListMode": "product-scan",
    "productIds": [1, 2]
  }
}
```

只有 `product-scan` 模式会读取产品和产品 Bug 列表；此时建议用 `source.productIds`
限定产品 ID。个人列表失败不会自动降级为全产品扫描，避免一次普通拉取意外变成数百次
请求。Token 从
`source.tokenEnv` 指定的环境变量读取，默认是 `ZENTAO_TOKEN`；如果环境变量不存在，
则读取 `source.tokenFile`。

推荐通过 npm 一键安装：

```bash
npx one-click-repair@latest setup --base-url https://zentao.example.com/zentao
```

从源码安装时可运行 `npm run bootstrap -- --base-url ...`。

命令会安装或更新 One-Click-Repair Plugin、生成用户配置、询问禅道登录账号，再由
macOS 系统钥匙串隐藏询问密码。密码只保存在 macOS 钥匙串中；账号和短期 Token
文件权限为 `0600`。

初始化时会请求 `POST /api.php/v1/tokens` 验证凭据并生成 Token。以后执行一键禅道时，
如果接口返回 `401`，程序会自动从钥匙串读取账号密码、重新获取 Token，并将原只读
拉取任务重试一次。密码不会写入配置、报告、日志或命令参数。

MCP Server 会自动查找 `ZENTAO_BUGFIX_CONFIG`、当前目录的
`.bugfix.local.json`，以及 Codex 用户目录下的
`zentao-frontend-bugfix/config.json`。因此安装完成后 Codex 可以在任意工作目录通过
`zentao_list_my_bugs` 拉取数据。兼容 CLI 仅用于诊断：

```bash
npm run start
```

没有完成初始化时，执行器会提示运行 `npx one-click-repair@latest setup`（源码安装
可运行 `npm run bootstrap`），不会在 Codex 聊天中索取密码。

### Fixture

用于开发、测试和规则调优：

```json
{
  "source": {
    "type": "fixture",
    "path": "./bugs.fixture.json"
  }
}
```

### 通用 REST

不同禅道版本的 URL、认证方式和响应结构可能不同，因此通过配置描述：

```json
{
  "source": {
    "type": "rest",
    "urlTemplate": "{baseUrl}/api/bugs?assignedTo={currentUser}&page={page}&limit={pageSize}",
    "baseUrl": "https://zentao.example.com",
    "pageStart": 1,
    "pageSize": 100,
    "maxPages": 20,
    "requestTimeoutMs": 15000,
    "requestRetries": 2,
    "retryDelayMs": 300,
    "headers": {
      "Authorization": "Bearer ${ZENTAO_TOKEN}"
    },
    "responseItemsPath": "data.bugs",
    "responseTotalPath": "data.total",
    "fields": {
      "id": "id",
      "title": "title",
      "description": "description",
      "steps": "steps",
      "severity": "severity",
      "priority": "pri",
      "affectedVersion": "openedBuild",
      "resolvedVersion": "resolvedBuild",
      "product": "productName",
      "project": "projectName",
      "execution": "execution",
      "executionName": "executionName",
      "module": "moduleName",
      "status": "status",
      "assignee": "assignedTo",
      "url": "url",
      "attachments": "files",
      "comments": "comments"
    }
  }
}
```

`${ENV_NAME}` 从环境变量读取。缺失环境变量会立即报错。

当配置了总数时，到达总数后停止翻页；否则当某页数量小于 `pageSize` 时停止。
达到 `maxPages` 但无法证明已经取完时会报错，避免静默遗漏 Bug。只有明确接受截断时才设置
`allowTruncatedResults: true`。

如果列表接口不返回完整描述、复现步骤或附件，配置详情补拉：

```json
{
  "source": {
    "detailUrlTemplate": "{baseUrl}/api/bugs/{bugId}",
    "detailIdPath": "id",
    "detailResponsePath": "data",
    "detailConcurrency": 4
  }
}
```

详情对象会覆盖列表项中的同名字段。批量补拉默认最多并发 4 个请求。
单个详情失败不会中断整批拉取，该 Bug 会以 `detail_failed` 和 `BLOCKED` 保留；某个
产品的 Bug 列表失败时其他产品仍继续处理。重试采用指数退避，并优先遵守
`Retry-After`。

### 图片附件

Bug 详情中的 `files`，以及描述、复现步骤、评论富文本里的 `<img>`，会在清除 HTML
前统一为附件元数据，并按文件 ID 或地址去重。只支持 PNG、JPEG、WebP 和 GIF，默认最大
5 MiB；图片按需在内存中读取，不写入磁盘。下载地址优先读取附件中的
`downloadUrl`、`url` 或 `webPath`。如果当前禅道只返回附件 ID，可配置：

```json
{
  "source": {
    "attachmentUrlTemplate": "{baseUrl}/your-download-route/{fileId}?bug={bugId}",
    "maxAttachmentBytes": 5242880
  }
}
```

下载地址及重定向必须与 `baseUrl` 同源；Token 不会发送给其他域名。如果禅道在同一
主机的富文本中生成 HTTP 图片地址，而 `baseUrl` 使用 HTTPS，执行器只会将该地址升级
为配置中的 HTTPS 协议和端口。不同主机、非默认 HTTP 端口、SVG、未知类型、扩展名与
内容不一致或超过限制的附件都会被拒绝。

## 接入自检

填写配置后可以运行：

```bash
npm run bugfix -- doctor --config /absolute/path/config.json
```

自检只检查 Fixture、认证环境变量和仓库目录，不会请求禅道、修改仓库或运行项目脚本。

## 按代码仓库线索保存仓库

推荐在 Bug 描述或评论中添加：

```text
问题代码仓库：example-react
```

也兼容 `问题仓库`、`代码仓库`、`所属仓库`、`仓库名称`、`前端项目`、
`所属项目` 和 `属于项目`。识别优先级为最新评论、描述、复现步骤、标题，用户在聊天
中的纠正优先级最高。拉取后使用仓库名作为稳定 key。用户首次提供目录后，将它写入
本地配置：

```json
{
  "repositoriesByProject": {
    "example-react": "/absolute/path/to/current-workspace"
  }
}
```

仓库名比较时忽略大小写。精确匹配失败时，仅当简称对应唯一已保存仓库才自动复用，
例如只有 `example-react` 时可用 `react` 指代；存在多个候选则询问用户。后续识别到同一
仓库时直接复用目录。
禅道所属执行只用于展示，不能作为仓库映射依据；同一执行下可能同时包含多个前端
项目，例如 `example-react` 和 `example-vue`。

仓库目录必须由用户提供，指向用户已经准备好的当前目录或 worktree。流程不自动搜索，
也不执行 Git 命令。

未识别到代码仓库时，用户可直接在聊天中补充，无需先修改禅道或重新拉取。Codex 调用
`bug_apply_user_supplement` 将仓库、问题类型、确认答案或是否仍需确认写入当前本地
报告并立即重新分诊。

Codex 使用 MCP 工具 `repository_set_by_project` 持久化映射，传入识别或补充的仓库名和
用户明确提供的仓库绝对路径，同时传入首次拉取返回的 `reportPath`。工具会读取现有
报告，在本地重新检查仓库并更新预分诊结果；该过程不请求禅道。Codex 直接使用返回的
`reportRefresh.items` 生成最终清单，不因保存映射而重新调用
`zentao_list_my_bugs`。

## 修改后复核

不要在配置中保存验证命令，也不要执行项目 `package.json` 中的 script、lint、test、
typecheck 或 build。修改后由 Codex 重新阅读改动文件及其调用链，逐项核对：

- Bug 的实际表现、预期表现和修改是否一一对应；
- 条件分支、状态流转、空值、类型和异常路径是否自洽；
- 导入、组件属性、文案及国际化是否与现有代码约定一致；
- 是否只触碰了与 Bug 直接相关的文件。

这种结果只能称为“代码逻辑复核通过”，不能称为运行时测试或构建通过。

## 分类策略

`policy.autoFixCategories` 是允许自动修复的类型白名单。即使类型在白名单中，
信息不足、高风险或没有仓库映射仍不会进入自动修复。

进入 `AUTO_FIX` 只表示进入“可直接修改”预览清单。用户看到预览后，针对具体 Bug
明确确认修改或直接给出具体修改方案，都算完成授权。Codex 调用
`workspace_select_for_bug` 时分别记录 `explicit-confirmation` 或
`user-provided-solution`，随后立即修改，不再询问第二遍。`NEED_CONFIRM` 和
`HUMAN_REQUIRED` 可由这次人工授权解锁；仓库或环境仍不可用的 `BLOCKED` 不可绕过。

可通过 `policy.highRiskKeywords` 添加团队特有的高风险词。默认风险词始终生效。

`policy.closedStatuses` 用于排除已关闭 Bug；比较时忽略大小写。
