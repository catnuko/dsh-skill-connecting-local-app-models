# connecting-local-app-models

一个 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) skill：
**把本机已安装应用的内部模型通道，做成 DSH 的 LLM provider。**

适用于任何"某个桌面应用/CLI 里已经登录了模型，想在 DSH 里直接用"的场景。
参考实现是 `dsh-connect-officeace`（复用 OfficeAce 的华为 MaaS 网关），
同族的还有 `dsh-connect-trae`、`dsh-qoder-connect`。

---

## 这个 skill 解决什么问题

让 DSH 复用一个**本机应用已经持有的模型凭据**，把它变成 DSH 里的一个 provider，
而**不改动** DSH profile 的默认模型。

典型触发场景：

- "能不能再写个插件，连上我本机的 XXX 软件，用它的模型？"
- 新装的 host 插件只报一句 `failed to import`，看不出原因
- 插件报 `invalid plugin, expect function or object with an "apply" method`
- 插件里 `import "@deepseek-ai/dsh-llm"` 报 `ERR_MODULE_NOT_FOUND`
- provider 注册了但永远不出现在 `listProviders()` 里

---

## 核心方法论

**先证明凭据链和上游协议在 DSH 之外能跑通，再写插件。**

插件只是最后一层胶水。凭据读取和 SSE 翻译都可以先用独立 `.mjs` 脚本验证。
跳过这一步，会把"上游不认"和"插件没装好"两类问题混在一起——而 DSH 的
`failed to import` 对这两者一视同仁，能让人在错误的层里改代码改到怀疑人生。

### 要不要回环 shim

| 上游协议 | 做法 |
|---|---|
| 已经是 OpenAI 兼容 | **直接手写 `LlmAdapter` + `fetch`**，不要 shim，不要 `dsh-llm-pi-ai` |
| 私有协议（自定义鉴权头、签名、非标准 SSE） | 起 `127.0.0.1:0` 回环 shim 翻译成 OpenAI 协议，再交给 `PiAiAdapter` |

多数桌面应用（Electron + 本地网关）用的就是 OpenAI 兼容网关，直连即可——
多一层 shim 就多一份要维护的鉴权、端口和生命周期代码。

---

## 内容结构

```
SKILL.md                                决策、流程、10 个陷阱
references/
  upstream-recon.md                     找凭据、找网关、实测模型能力、提取 asar
  host-adapter.md                       LlmAdapter 契约、StreamChunk 协议、错误码、消息投影
  install-traps.md                      安装失败、failed to import、解析路由、重启判断
  verification.md                       四层验证：装完怎么证明真的能用
  env-and-tooling-traps.md              inspect 命名、node 版本、PowerShell/asar 操作坑、skill 契约
templates/
  package.json                          可直接改的插件清单（3 个 peerDependencies，0 个 dependencies）
  cordis.patch.yml                      注册 entry
  lib/index.js                          适配器骨架（含 SSE 翻译、错误翻译、usage 缓冲）
  lib/credentials.js                    凭据读取骨架（SQLite + 旧链路回退）
  scripts/pack.mjs                      打包成带 package/ 前缀的 .tgz
```

`templates/` 里的骨架是**可以直接改的工作代码**，不是伪代码。

---

## 安装

把整个目录放到 DSH 的 skill 根目录之一（`<DSH_HOME>` 默认是 `~/.dsh`）：

```powershell
# 跨工作空间通用（推荐）
Copy-Item -Recurse connecting-local-app-models "$HOME\.dsh\skills\"

# 或只给某个项目用
Copy-Item -Recurse connecting-local-app-models "<项目根>\.dsh\skills\"
```

DSH 会在下一次发现 skill 时加载它。发现规则：

- 形式只有两种：`<根>/<名字>/SKILL.md` 或 `<根>/<名字>.md`，**更深的嵌套不会被发现**
- 首行必须是字面的 `---`（无 BOM）
- frontmatter 必须**同时**有 `name` 和 `description`
- `name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`

> 如果复制后 `skill` 工具仍报 unknown，可能是当前 agent preset 的
> `skill-filesystem` 未挂载该根目录，或 catalog 尚未刷新——这不是文件内容问题，
> 详见 `references/env-and-tooling-traps.md` 第 6 节。

---

## 六个最耗时的坑（摘要）

1. **绝不安装源码目录** —— `install_bundle` 会写成 `link:`，pnpm 生成 junction，
   裸包名解析失败，只报一句 `failed to import`。必须打包成 `.tgz`。
2. **失败按 entry id 缓存** —— 同一 entry id 重装不会重新 import，排查必须换新 id。
3. **裸包名解析路由在启动时钉死且进程内缓存** —— 改完必须重启 DSH 桌面应用。
4. **`stream()` 抛普通 `Error` 会退化成 `code: "UNKNOWN"`** —— 不在默认可重试集合里，
   必须翻译成 `LlmError`。
5. **`StreamChunk` 判别字段是 `type` 不是 `kind`**，且 `usage` 必须在 `finish` 之前。
6. **每个 provider HTTP 请求都必须带 `attributionHeaders()`**。

完整 10 条见 `SKILL.md`。

---

## 免责声明

本 skill 描述的是**复用本机应用自己持有的凭据**，不是官方开放 API。

- 凭据属于用户自己的账号，调用会消耗该账号在宿主应用/云厂商的配额。
- 宿主应用升级可能改变凭据存储方式，需要相应更新读取逻辑。
- 请遵守宿主应用的服务条款。仅供个人学习与自用。

## License

MIT