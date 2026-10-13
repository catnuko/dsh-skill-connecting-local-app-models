# 装完之后怎么证明真的能用

`application: "applied"` **只证明安装动作成功了，不证明插件能用。** 必须走完下面四层，每层都能独立失败。

## 第 1 层：安装结果

```
plugin_manager action: install_bundle, target: <绝对 .tgz 路径>
```

读返回的 **`application`**（`applied` / `restart-required` / `cancelled`）和 **`warnings`**。这两个字段决定是否生效——**不是**服务端日志、终端输出、进程列表或页面 boot payload。

## 第 2 层：条目激活状态

```
cordis_inspect_query(platform: "host", provider: "Config", method: "listConfigs", input: {name: "<包名>"})
```

期望 `status: "schema"`。**这是最权威的激活判据**：插件加载成功才有 schema；失败时这里显示的正是 `failed to import`。

再查具体条目拿 `packageDir`：

```
listConfigs {entry: "include:<entry id>"}
```

`packageDir` **必须指向 profile 的副本**（`<profile>\node_modules\<pkg>`），而不是源码目录。指向源码目录 = 陷阱 3，需要重启。

`cordis_inspect_query` **不需要审批**，比翻 `list_plugins` 好；后者的大列表在会话里会被中间裁剪，要用 `offset` + `limit: 1` 分页。

## 第 3 层：provider 与模型发现

写一个探针脚本（新包名 + 新 entry id）在 host 里执行：

```js
const providers = ctx.llm.listProviders().map((p) => p.id);
// 期望包含你的 provider
```

再查模型发现——**必须用真实插件的 entry id**，不是探针的：

```
discovery[<真实 entry id>]: N rows
```

期望每行的 `contextWindow` 与 `maxTokens` 与你实测的值一致。

**常见误判**：探针用自己的 namespace 查 discovery 会失败（`no model discovery is registered for "<探针 id>"`）。这是设计如此，不是 bug。

## 第 4 层：真实流式调用（唯一算数的证据）

前面三层全绿也可能调用不通。必须发一次**真实请求**并检查 chunk 序列：

```js
const chunks = [];
for await (const chunk of ctx.llm.stream({
  provider: "<你的 provider>", model: "<实测可用的模型>",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: LIVE" }] }],
})) chunks.push(chunk);
```

检查清单：

- [ ] 拿到非空文本
- [ ] chunk 序列顺序正确：`block-start` → deltas → `block-end` → `usage` → `finish`
- [ ] **`usage` 出现在 `finish` 之前**
- [ ] `finish.reason.kind` 是 `stop`（不是 `error`）
- [ ] usage 的 token 数是**真实非零值**（不是 `inputTokens: 0`）

**`finish.reason.kind === "error"` 时，检查 `failure.code`**：

- `code: "UNKNOWN"` → 适配器漏了错误翻译（见 `host-adapter.md`）。这是最常被忽略的失败模式。
- `code: "INVALID_CREDENTIAL"` → 凭据链断了，检查宿主应用是否还登录着。

## 单元测试与实况测试分开

两套都要有，它们抓不同的问题：

| 测试 | 做法 | 抓什么 |
|---|---|---|
| 单元测试 | stub `globalThis.fetch`，用 `ReadableStream` 喂假 SSE，配真实 `BlockAssembler` | chunk 翻译逻辑、顺序、边界（`[DONE]`、空 delta、tool_calls 分片、usage 末帧） |
| 实况测试 | 真实凭据 + 真实网关 | 凭据链、鉴权头、真实模型能力、上游措辞 |

单元测试用真实 `BlockAssembler` 很关键——它会把 chunk 序列的错误直接暴露成断言失败，而不是等你上线才发现。

**实况测试不要打印 key/token**，只断言长度、布尔值和 HTTP 状态。

## 上游限流

很多网关有每秒 1 次的限流（返回 HTTP 429 `Too many requests, the rate limit is 1 per second`）。批量探测模型能力时**每个请求之间 sleep ≥ 1.1–1.3 秒**，否则你会把 429 误判成"模型不可用"。

## 探测上限时的文本压缩陷阱

用超大 prompt 探测上下文上限时，**不要用重复字符**（`"a".repeat(N)`）——上游的 tokenizer 会把长重复串压缩，导致实际 token 数远低于预期，永远触发不了溢出。**用高熵随机文本。**

## 一个必须警惕的数据丢失风险

本 skill 的参考案例中，插件源码目录曾被静默清空过一次。**在装/卸 bundle 前后都核对源码文件列表和哈希。** 开始动手前先做一份备份副本。
