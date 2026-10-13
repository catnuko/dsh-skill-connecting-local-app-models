---
name: connecting-local-app-models
description: Use when asked to build or fix a DSH host plugin that reuses the internal models, LLM gateway, or login credentials of another locally installed application (an IDE such as Trae or Qoder, a desktop app such as OfficeAce, or a similar CLI/tool), or when a freshly installed host plugin reports `failed to import`, `invalid plugin, expect function or object with an "apply" method`, `ERR_MODULE_NOT_FOUND` for a dsh-shipped bare package, or a provider row that never appears in `listProviders`. Also for turning any OpenAI-compatible or proprietary upstream endpoint into a DSH `LlmAdapter` provider.
---

# 把本机应用的模型接进 DSH

把一个本机已安装应用（下称"宿主应用"）的内部模型通道，做成 DSH 的 provider。

**核心原则：先证明凭据链和上游协议在 DSH 之外能跑通，再写插件。** 插件只是最后一层胶水；凭据读取和 SSE 翻译都可以用独立 `.mjs` 脚本先验证。跳过这一步会把"上游不认"和"插件没装好"两类问题混在一起，而 DSH 的报错（`failed to import`）对这两者一视同仁。

## 决策：要不要回环 shim

| 上游协议 | 做法 |
|---|---|
| 已经是 OpenAI 兼容（`POST {base}/chat/completions`，标准 SSE） | **直接手写 `LlmAdapter` + `fetch`**。不要 shim，不要 `dsh-llm-pi-ai`。 |
| 私有协议（自定义鉴权头、签名、非标准 SSE） | 起 `127.0.0.1:0` 回环 shim 翻译成 OpenAI 协议，再交给 `dsh-llm-pi-ai` 的 `PiAiAdapter`（Trae/Qoder 的做法）。 |

先探测上游。多数桌面应用（Electron + 本地网关）用的是 OpenAI 兼容网关，直连即可——多一层 shim 就多一份要维护的鉴权、端口和生命周期代码。

## 流程

1. **侦察宿主应用**：找到凭据存哪、网关地址怎么算。见 `references/upstream-recon.md`。
2. **在 DSH 之外打通链路**：写一个独立 `.mjs`，用真实凭据发一次真实请求，拿到 HTTP 200 和真实 token。**这一步不通过就不要写插件。**
3. **实测模型能力**：逐个模型测可调用性、上下文上限、`reasoning_effort` 合法集合、是否支持图片/工具调用。广告的模型列表通常远大于真正可用的。见 `references/upstream-recon.md`。
4. **写插件**：`package.json` + `cordis.patch.yml` + `lib/index.js`（+ 可选 `lib/credentials.js`）。见 `references/host-adapter.md`，模板在 `templates/`。
5. **打包成 `.tgz` 并安装**：`node scripts/pack.mjs` → `plugin_manager` `install_bundle`，`target` 指向 `.tgz` 绝对路径。**不要安装源码目录**，见 `references/install-traps.md`。
6. **验证**：`application`/`warnings` 只是第一步；必须用 `cordis_inspect_query` 确认条目 `status: "schema"`，再跑一次真实流式调用。见 `references/verification.md`。

## 必须知道的陷阱

前三个会让人误判成"插件代码有 bug"，实际都是安装/解析层的问题。

1. **绝不安装源码目录。** `install_bundle` 对本地目录会写成 `link:` 依赖，pnpm 生成 junction，插件真实路径落在 profile 树外，被归类为 linked layer → `@deepseek-ai/dsh-llm` 等 dsh 自带裸包名解析失败 → 只报一句 `failed to import`。**必须打包成 tarball 安装**，且 tarball 内顶层必须是 `package/`（否则 pnpm 报 `ERR_PNPM_INVALID_DEPENDENCY_NAME`）。
2. **失败按 entry id 缓存。** 同一个 entry id 重新安装不会重新 import。排查时必须换新 entry id（或改包名），否则会把旧失败当成新失败。
3. **裸包名解析路由在启动时固定，且进程内缓存。** 插件改好、重装、甚至文件字节一致之后，正在运行的 DSH 仍可能把包名解析到旧位置。`PluginPackages.replace()` 是唯一的刷新 API 且**没有任何调用者**，所以**改完必须重启 DSH 桌面应用**。判断方法见 `references/install-traps.md`。
4. **`stream()` 抛出的普通 `Error` 会退化成 `code: "UNKNOWN"`**，而 `UNKNOWN` 不在默认可重试集合（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`）里。**所有凭据和传输失败都必须在适配器内翻译成 `LlmError`**，否则用户看到的是不可重试的静默失败。
5. **`StreamChunk` 的判别字段是 `type`，不是 `kind`**；顺序上 `usage` 必须在 `finish` 之前，`finish` 之后不能再有任何 chunk。网关常把 usage 放在 `finish_reason` **之后**的 `choices: []` 末帧里，所以 finish 要缓冲到流末尾再发。
6. **每个 provider HTTP 请求都必须带 `attributionHeaders()`**，这是 `LlmAdapter` 的契约要求。

### 排查过程本身的坑

下面这些坑看起来都像"插件坏了"，实际是环境/工具问题，浪费的时间最多：

7. **`cordis_inspect` 名字必须精确**：skill 注册表的 Service 键是复数 **`skills`**（不是 `skill`），且**没有 `loader` 这个 Service**；`listConfigs` 的 `name` 是包名、`entry` 必须写成 `include:<entry id>`。
8. **用 DSH 内置的 node**（`resources\runtime\primary-runtime\dependencies\node\bin\node.exe`），不要用 PATH 上的——两者版本可能不同。
9. **PowerShell 读 JSON 一律用 node 的 `fs.readFileSync`**；多行脚本或含 Windows 路径的脚本写成 `.mjs` 文件再跑（`node -e` 双引号会吃掉反斜杠）；大输出写文件，别打管道。
10. **skill 可见性按 scope 分层**：探针插件只能看到 global 层，看不到 preset 层的 skill。**探针看不到 ≠ skill 写错了**——判断能否加载要用 `skill` 工具实际加载。

细节见 `references/env-and-tooling-traps.md`。

## 参考文件

| 需要什么 | 读哪个 |
|---|---|
| 找凭据、找网关、实测模型能力与上限 | `references/upstream-recon.md` |
| `LlmAdapter` 契约、消息投影、StreamChunk 协议、错误码 | `references/host-adapter.md` |
| 安装失败、`failed to import`、解析路由、重启判断 | `references/install-traps.md` |
| 装完之后怎么证明真的能用 | `references/verification.md` |
| `cordis_inspect` 名字、node 版本、PowerShell/asar 操作坑、skill 发现契约与可见性 | `references/env-and-tooling-traps.md` |
| 可直接改的骨架 | `templates/`（`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/credentials.js`、`scripts/pack.mjs`） |
| 官方插件开发契约与 UI 插件 | `cordis-plugin-development` skill |
| 组合、预设、行归属哪个平面 | `editing-cordis-compositions` skill |
