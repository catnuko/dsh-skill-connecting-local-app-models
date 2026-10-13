# LlmAdapter 契约与 StreamChunk 协议

写适配器前先确认版本：`@deepseek-ai/dsh-llm` 的 API 在 rc 之间会变。本文件基于 `0.2.0-rc.2` 实测。

## 插件导出形式（不要混用）

合法形式二选一：

```js
// 形式一：命名导出（推荐）
export const name = "dsh-connect-xxx";
export const inject = ["llm"];
export const Config = z.object({ /* ... */ });
export function apply(ctx, config) { /* ... */ }

// 形式二：service class 作 default export
export default class XxxService extends Service { }
```

**没有 `definePlugin` / `createPlugin`。** 写错会得到 `invalid plugin, expect function or object with an "apply" method`。

`apply` / `inject` / `name` / `Config` **都是命名导出**，`export default` 不是必需的——Trae 和 Qoder 两个能用的插件都没有 default export。

## Config 用 schemastery，不是 zod

```js
import z from "@deepseek-ai/schemastery";
```

**只有 `.volatile()` 字段会出现在 Web 设置表单里，也只有它们能被界面写入。** 非 volatile 字段被 UI 写入时会报 `Plugin entry "<x>" has no volatile fields`，而且 `set()` 仍然 resolve → **静默回滚**（用户以为改了其实没改）。

`volatile()` 的语义容易搞错：它**返回同一个 Schema 并打上 meta 标记，不是包一层 wrapper**。所以：

- `volatile()` 之后的字段在 parse 后物化成 `{get()}` 对象；非 volatile 字段是裸值。
- **volatile 里不能嵌套 volatile**，否则抛 `volatile fields require a fixed object path without an enclosing volatile field`。
- 取值要 `isVolatile(v) ? v.get() : v` 解包。
- 探测某个 Schema 能否 volatile 化：`typeof schema.volatile === "function"`。

```js
const asVolatile = (schema) =>
  typeof schema.volatile === "function" ? schema.volatile() : schema;

export const Config = z.object({
  installRoot: asVolatile(z.string().description("留空自动探测")),
  // 非 volatile：不出现在表单，只能改代码/配置文件
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
});
```

## 注册到 ctx.llm

`inject: ["llm"]`，然后：

```js
export function apply(ctx, config) {
  const settingsNs = ctx.fiber.entry?.options?.id ?? "<default>";
  const registration = { adapter: undefined, discovery: undefined, directory: undefined };

  registration.adapter = ctx.llm.registerAdapter([PROVIDER], adapter);
  registration.discovery = ctx.llm.registerModelDiscovery(settingsNs, async (request) => { /* ... */ });
  registration.directory = ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: PROVIDER_NAME, settingsNs, settingsPath: [], declared: false },
  ]);

  // settings 是软依赖：缺席不影响 provider 注册
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      ctx.effect(() => settingsCtx.settings.configure({ auto: true }, ctx.fiber));
    } catch (error) {
      ctx.logger.warn("<plugin>: settings namespace unavailable", error);
    }
  });

  ctx.effect(() => () => {
    registration.discovery?.();
    registration.adapter?.();
    registration.directory?.();
  });
}
```

要点：

- 三个 register 都返回**可调用的 disposer**，用 `ctx.effect` 统一清理。
- `registerAdapter` 是**全有或全无**：providers 列表里任何一个不合法，整个注册失败。
- `registerModelDiscovery` 以 `settingsNs` 为键；**同一个 namespace 重复注册报 `DUPLICATE_DISCOVERY`**。所以探针包用自己的 entry id 查不到真实插件的 discovery，这是正常的。
- `settings.configure({auto: true}, ctx.fiber)` **必须作为 effect 里的方法调用**，不能裸调。
- 设置命名空间取 `ctx.fiber.entry?.options?.id`；它也是 entry id（`cordis.patch.yml` 里的 `insert[].id`）。

## LlmAdapter 方法

| 方法 | 必须 | 说明 |
|---|---|---|
| `providerInfo(provider)` | 是 | 返回 `{id, name}`；**`id` 必须严格等于 `provider`**，否则 `INVALID_ADAPTER` |
| `stream(options)` | 是 | 返回 `AsyncIterable<StreamChunk>` |
| `listModels(provider)` | 否 | 默认 `[]`。每行需 `provider === provider`、非空 `id`、非空 `name`；重复 id 报 `INVALID_CATALOG` |
| `resolveModel(provider, model, signal)` | 否 | 默认 `{provider, id: model, name: model}` |
| `providerRetryPolicy(provider)` | 否 | 默认 `undefined` |
| `prepareCall(provider, model, signal)` | 否 | |
| `imageRequestPricing(provider, model)` | 否 | **必须同步返回，不能有 I/O** |

`resolveModel` 的返回值会被校验，**只有这些字段被接受**：

```js
{
  provider, id, name,                    // provider===provider, id===model, name 非空
  description?,
  inputModalities?,                      // 声明 ["text"] 后运行时会把图片换成文本占位符
  context: { contextWindow },            // 必须整数且 > 0，否则 INVALID_MODEL_CONTEXT
  defaultMaxTokens?,                     // 正整数
  systemPromptUpdate?,                   // 只能是 "in-history"
  toolUpdate?,                           // "in-history" | "addition-only"
  reasoning?: {
    efforts: [{ id, name, description? }],   // 不能为空数组
    defaultEffort?,                          // 必须在 efforts 里
  },
}
```

**不设 `defaultEffort`**：不显式请求 effort 时就不发 `reasoning_effort`，沿用上游默认，行为最贴近宿主应用本体。

`GenerateOptions` 的字段：`{provider, model, reasoningEffort?, messages, system?, tools?, toolHistory?, temperature?, maxTokens?, stop?, sessionId?, signal?}`。

## StreamChunk 协议

**判别字段是 `type`，不是 `kind`。**

| chunk | 载荷 |
|---|---|
| `block-start` | `{index, blockType: 'text'\|'reasoning'\|'tool-call'}` |
| `text-delta` / `reasoning-delta` | `{index, text}` |
| `tool-call-delta` | `{index, id, name?, argumentsDelta}` |
| `block-end` | `{index, block: {type:'text',text} \| {type:'reasoning',text} \| {type:'tool-call',id,name,arguments}}` |
| `usage` | `{usage: {inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?}}` |
| `finish` | `{reason: {kind: 'stop'\|'max-tokens'\|'tool-calls'\|{kind:'error',failure}\|{kind:'aborted',failure}}, replayState?}` |

硬性顺序：

- **`usage` 必须在 `finish` 之前**；`finish` 之后不能再有任何 chunk。
- `block-start` 必须在同 index 的第一个 delta 之前；重复的 `block-start` 会被忽略。
- 块顺序：`block-start` → 若干 delta → `block-end`。

**网关常把 usage 放在 `finish_reason` 之后的 `choices: []` 末帧里**，所以不要一看到 `finish_reason` 就发 finish——缓冲到流末尾（`[DONE]` 或流结束）再发 `usage` + `finish`。

## 错误处理（最容易出错的地方）

`stream()` 抛出的**普通 `Error` 会退化成 `code: "UNKNOWN"`**：

- 失败归一化逻辑只在错误自带 `HarnessError` 快照且 code 自洽时才采信，否则用 `harnessErrorCode(error)`，而它对非 `HarnessError` 一律返回 `"UNKNOWN"`。
- **`UNKNOWN` 不在默认可重试集合里**（默认集合是 `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`，默认最多重试 5 次）。

**所以适配器必须把所有凭据和传输失败翻译成 `LlmError`：**

```js
import { INVALID_CREDENTIAL_CODE, LlmError } from "@deepseek-ai/dsh-llm";

// 凭据失败
throw new LlmError(`credential unavailable (${error.code}): ${error.message}`, INVALID_CREDENTIAL_CODE);

// HTTP 状态映射
if (status === 401 || status === 403) return new LlmError(msg, "AUTH", { status });
if (status === 429) return new LlmError(msg, "RATE_LIMIT", { status, providerRetryAfterMs });
if (status >= 500) return new LlmError(msg, "SERVER", { status });
if (isContextWindowExceededError(text)) return new LlmError(msg, CONTEXT_WINDOW_EXCEEDED_CODE);
if (isQuotaExceededError(text)) return new LlmError(msg, QUOTA_EXCEEDED_CODE);
return new LlmError(msg, "INVALID_REQUEST", { status });
```

`LlmError(message, code, options?)` 的 `options`：`status`（100–599 整数）、`providerRetryAfterMs`（正有限数）、`requestId`（非空字符串）。空 `message`/`code` 会抛普通 `Error`。

**两个必须自己判的上游措辞**：`isContextWindowExceededError` / `isQuotaExceededError` 只匹配**结构化英文措辞**。宿主应用的中文/厂商特有措辞（OfficeAce 的 `Prompt length exceeds: ...`、`ModelArts.81027`）都不匹配，**必须在适配器里自己写正则补充**。

**流中途的失败也要包。** 迭代过程中抛出的非 `LlmError` 同样会退化成 `UNKNOWN`：

```js
async *stream(options) {
  const credential = await this.#credentials();          // 内部已转 LlmError
  let response;
  try {
    response = await fetch(url, { headers: { ...attributionHeaders(), authorization }, ... });
  } catch (error) {
    throw transportFailure(error, options.signal);        // abort → ABORTED，其余 → TRANSPORT
  }
  if (!response.ok) throw await httpFailure(response);
  try {
    yield* this.#translate(response.body, options.signal);
  } catch (error) {
    if (error instanceof LlmError) throw error;            // 已有稳定 code 的原样抛出
    throw transportFailure(error, options.signal);
  }
}
```

**每个 provider HTTP 请求都要带 `attributionHeaders()`**，这是契约要求。

## 消息投影

Harness 消息角色：`user` / `assistant` / `system` / `tool` / `developer`。
内容块：`{type:'text',text}`、`{type:'reasoning',text}`、`{type:'tool-call',id,name,arguments}`、`{type:'image',attachment}`、`{type:'file'}`。

投影到上游时：

- **`developer` 角色通常要降级为 `system`**——很多网关的 role 白名单里没有 `developer`（OfficeAce 会 400）。
- **`tool` 消息保留原生 `role:"tool"` + `tool_call_id`**——先实测，不要盲目重写成 user。
- `assistant` 的 `reasoning` 块可以回显为 `reasoning_content`（实测上游接受）。
- `options.system` 与历史里的 system 消息都要带上；上游接受中段 system 时才可声明 `systemPromptUpdate: "in-history"`。

## 失败诊断

| 报错 | 含义 |
|---|---|
| `invalid plugin, expect function or object with an "apply" method` | 导出形式不对，或用了不存在的 `definePlugin` |
| `INVALID_ADAPTER` | `providerInfo().id !== provider`，或 providers 为空 |
| `DUPLICATE_ADAPTER` | 该 provider 已被别的适配器占用（可能是旧 fiber 还活着） |
| `INVALID_MODEL_INFO` / `INVALID_MODEL_CONTEXT` / `INVALID_MODEL_MAX_TOKENS` / `INVALID_MODEL_REASONING` | `resolveModel` 返回值不合规，见上文字段表 |
| `INVALID_CATALOG` | `listModels` 有重复 id，或 id/name 为空 |
| `UNSUPPORTED_REASONING_EFFORT` | 请求了 effort 但模型没声明 `reasoning.efforts`，或该 effort 不在集合里 |
| `failed to import` | 模块求值失败——**通常是解析问题，不是代码问题**，见 `install-traps.md` |
| `UNKNOWN` | 适配器漏了错误翻译，见上文 |
