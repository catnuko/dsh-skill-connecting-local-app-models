# 侦察宿主应用

目标：拿到两样东西——**能用的凭据**和**正确的网关地址**——并在写插件前证明它们能换来一次 HTTP 200。

## 1. 先看应用用什么技术栈

| 现象 | 含义 | 凭据通常在哪 |
|---|---|---|
| 有 `resources/app.asar`，进程里是 Electron | Electron 应用 | 用户目录下的 profile/secure-config，常被 OS 级加密 |
| 有独立的 service host 进程 | 主程序 + 服务进程分离 | 服务进程的数据目录（常是 SQLite） |
| 有 `packages/api/dist/` | 打包过的 Node 后端 | 应用自己的数据目录 |

**读 `app.asar` 要小心**：它不是 zip，是「头部 16 字节 + JSON 目录 + 内容」的自定义格式。JSON 长度在 **offset 12**（不是 4，也不是文件尾部），JSON 从 offset 16 开始；文件内容是 `16 + jsonLength + offset`。目录是嵌套树（子节点在 `files` 字段里），**顶层只有少数几个 key**，必须递归遍历才能找到目标包。详见本文件的「提取 asar 文件」。

## 2. 找凭据：优先看数据目录，而不是加密文件

先枚举应用的数据目录和用户目录（`%LOCALAPPDATA%\<App>`、`%APPDATA%\<App>`、`~/.<app>`），再决定走哪条链。

**优先级：明文/SQLite > 应用自己的解密函数 > OS 级加密（DPAPI/Keychain）。**

应用升级会换掉凭据存储方式。OfficeAce 从 1.3.3 升到 1.3.4 后，旧的 DPAPI profile 文件整个消失，改用 SQLite KV 表——如果只实现了 DPAPI 链，升级后插件直接失效。**所以两条链都要实现，运行时按存在性选择。**

典型形态：

- **SQLite KV**（最省事）：`storage.sqlite` 里一张 `*_kv_string` 表，值是 JSON。用 `node:sqlite` 的 `DatabaseSync` 以 `readOnly: true` 打开。
- **AES-GCM 加密的 profile**：密钥本身由 OS 级加密（DPAPI）保护。链是 `OS 解密 → sha256 → AES-256-GCM 解密 profile`。
- **环境变量 / 配置文件**：最理想，直接用。

**读凭据前先定位"属于谁"**：多账号应用会按 userId 分目录。找 `*owner*.json` / `*current*user*` 之类的文件拿 id，再用它拼出凭据路径。不要假设只有一个用户。

**解密要在应用进程外复现。** 如果应用导出了加解密函数（打包产物里常有 `encryptJson`/`decryptJson`、`buildXxxAuthorization`），直接读它的实现来对齐算法和参数顺序，比猜快得多。

## 3. 找网关地址

**不要硬编码网关地址。** 它通常是 per-user 的，存在凭据同一处（OfficeAce 存在 session 的 `modelInfo.model_api_url_base`）。

两个常见坑：

- **存的是不带 scheme 的裸主机名**，需要自己补 `https://`，并常常要补 `/v2` 之类的路径前缀。
- **地址会随账号/区域变化**，所以每次 `resolve()` 都重新读，而不是进程启动时读一次。

## 4. 实测模型能力（最关键的一步）

**`GET /models` 广告的列表通常远大于真正能用的。** OfficeAce 广告 28 个，实测只有 9 个可用：其余返回 404 `ModelArts.81009`、403 无权限、或 400。

对每个模型分别确认：

| 要确认的事 | 怎么测 |
|---|---|
| 能不能调用 | 发一次最小请求，看 HTTP 状态和错误码 |
| 上下文上限 | **故意发超大 prompt**，让上游在 400 里回显真实上限 |
| `reasoning_effort` 合法集合 | **故意发非法值**，让上游在 400 里回显合法集合 |
| 是否支持图片 | 发一个 `image_url` 内容块，看是否 400 |
| 是否支持工具调用 | 发 `tools`，看是否返回 `tool_calls` |
| 是否返回推理内容 | 看 delta 里有没有 `reasoning_content` |

**"故意发错让上游回显正确答案"比查文档可靠**——文档通常不存在或是过期的。把每次实测结果记进代码注释和 README，因为下次没人知道这些数字是怎么来的。

同时确认几个协议细节：

- **`developer` role 是否被接受**（不接受就要降级为 `system`）。
- **原生 `role:"tool"` + `tool_call_id` 是否被接受**（接受就不要重写成 user）。
- **中段 `system` 消息是否被遵守**（决定 `systemPromptUpdate` 能不能用 `"in-history"`）。
- **usage 在哪一帧**（很多网关放在 `finish_reason` 之后的 `choices: []` 末帧）。
- **`reasoning_content` 的位置**（常见是 `delta` 的兄弟字段，不是 content 数组里的块）。

## 5. 常见备选通道（按优先级）

直连上游网关通常是最好的。若不行，按此顺序退让：

1. **直连上游网关**——最直接，本 skill 的主路径。
2. **本机 REST API**（用应用的 cookie/session）——先确认它到底有没有"调用模型"的端点。OfficeAce 有 446 个路由可用，但**没有一个能调模型**，所以这条看起来很美实际不通。
3. **stdio MCP server**——应用若暴露 MCP，可作为可行退路。
4. **CDP / Electron 调试端口**——脆弱，最后考虑。

**先验证通道真的能调模型，再投入实现。** "能访问 API"和"能调模型"是两件事。

## 提取 asar 文件

asar 头部布局：`u32 @0 = 4`、`u32 @4 = 头部大小`、`u32 @8 = 头部大小 + 4`、**`u32 @12 = JSON 精确字节长度`**，JSON 从 **offset 16** 开始。文件内容偏移 = `16 + jsonLength + entry.offset`。

必须**递归遍历** `files` 树：顶层只有 `dsh` 等少数 key。

```js
import fs from "node:fs";
const fd = fs.openSync(asarPath, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const buf = Buffer.alloc(jsonLen);
fs.readSync(fd, buf, 0, jsonLen, 16);
const idx = JSON.parse(buf.toString("utf8"));

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix + "/" + name;
    if (child.files) walk(child.files, p, out);
    else out.push({ path: p, size: child.size, offset: Number(child.offset) });
  }
}
```

两个操作层面的坑：

- **把结果写进文件，不要靠 stdout。** 大 JSON 打到管道会让 Node 进程挂住（表现为命令超时后被移到后台）。
- **`Number(child.offset)`**：offset 可能是字符串。

## 凭据卫生

- 探针只输出**长度、布尔值、HTTP 状态码**，绝不打印 key/token 原文。
- 缓存凭据时按 **mtime 失效**（profile 文件和它的 `-wal` 都要看），这样应用续期或轮换密钥后插件能自愈。
- **插件无法自己续期登录。** 会话过期时只能让用户重新打开宿主应用。这一点要在 README 和错误信息里写清楚，并且把凭据失败翻译成 `INVALID_CREDENTIAL` 而不是泛化错误。
