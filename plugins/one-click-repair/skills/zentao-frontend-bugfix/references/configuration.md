# 配置参考

## 路径规则

- 配置中的相对路径以配置文件所在目录为基准。
- `repoPath` 推荐使用绝对路径。
- `outputDir` 保存分诊报告和工作区元数据。

## 数据源

### 禅道开源版 21.6

优先使用内置的 REST API v1 适配器：

```json
{
  "source": {
    "type": "zentao-v1",
    "baseUrl": "https://zentao.example.com",
    "tokenEnv": "ZENTAO_TOKEN",
    "tokenFile": "./secrets/zentao-token",
    "accountFile": "./secrets/zentao-account"
  }
}
```

`currentUser` 可以省略，首次拉取时通过 `GET /api.php/v1/user` 从 Token 自动识别账号。
如需固定账号或做离线测试，也可以显式填写。

执行器会依次请求：

1. `GET /api.php/v1/products`
2. `GET /api.php/v1/products/{productID}/bugs?limit=100&page=1`
3. 仅对指派给当前账号且未关闭的 Bug 请求 `GET /api.php/v1/bugs/{bugID}`

如果禅道安装在子路径下，`baseUrl` 包含子路径，例如
`https://example.com/zentao`。如果直接填写以 `/api.php/v1` 结尾的地址也可以。

可用 `source.productIds` 限定产品 ID，避免扫描无关产品。Token 从
`source.tokenEnv` 指定的环境变量读取，默认是 `ZENTAO_TOKEN`；如果环境变量不存在，
则读取 `source.tokenFile`。

首次安装在 One-Click-Repair 项目目录执行：

```bash
npm run bootstrap -- --base-url https://zentao.example.com/zentao
```

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

没有完成初始化时，执行器会提示运行 `npm run bootstrap`，不会在 Codex 聊天中索取
密码。

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

## 接入自检

填写配置后可以运行：

```bash
npm run bugfix -- doctor --config /absolute/path/config.json
```

自检只检查 Fixture、认证环境变量和仓库目录，不会请求禅道、修改仓库或运行项目脚本。

## 按评论中的所属项目保存仓库

用户查看或创建 Bug 时，在评论中添加：

```text
所属项目：sisreact
```

拉取后使用该项目名作为稳定 key。兼容旧写法 `属于项目：sisreact`，多个标记存在时
以最新评论为准。用户首次提供目录后，将它写入本地配置：

```json
{
  "repositoriesByProject": {
    "sisreact": "/absolute/path/to/current-workspace"
  }
}
```

项目名比较时忽略大小写。后续评论标记同一项目时直接复用该目录，不再询问用户。
禅道所属执行只用于展示，不能作为仓库映射依据；同一执行下可能同时包含多个前端
项目，例如 `sisreact` 和 `sisvue`。

仓库目录必须由用户提供，指向用户已经准备好的当前目录或 worktree。流程不自动搜索，
也不执行 Git 命令。

评论缺少 `所属项目：XXX` 时，先提示用户在禅道补充备注并重新拉取，不能从标题、
所属执行、禅道项目字段或本地目录猜测。

Codex 使用 MCP 工具 `repository_set_by_project` 持久化映射，传入评论中的项目名和
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

进入 `AUTO_FIX` 也只表示进入“可直接修改”预览清单。只有用户看到最终清单并在聊天中
明确回复 `确认修改` 后，Codex 才能调用 `workspace_select_for_bug` 并修改代码。

可通过 `policy.highRiskKeywords` 添加团队特有的高风险词。默认风险词始终生效。

`policy.closedStatuses` 用于排除已关闭 Bug；比较时忽略大小写。
