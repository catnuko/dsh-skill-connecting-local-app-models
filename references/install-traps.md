# 安装陷阱与 `failed to import` 排查

**`failed to import` 几乎总是解析/安装层的问题，不是插件代码的问题。** 这个报错对以下所有原因一视同仁，所以必须按固定顺序排除，否则会在错误的层里改代码改到怀疑人生。

安装只能用 `plugin_manager` 的 `action: install_bundle`，`target` 是**绝对 `.tgz` 路径**或绝对包目录。判定是否生效看返回的 **`application`** 和 **`warnings`**——不是服务端日志、终端输出或进程列表。

## 陷阱 1：绝不安装源码目录

`install_bundle` 对本地**目录**会写成 `link:<path>` 依赖，pnpm 生成 junction。插件真实路径落在 profile 树之外，DSH 的模块解析层把它归类为 **linked layer**，于是 dsh 自带的裸包名（`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`）全部解析失败：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

模块求值直接 reject → 没有 fiber → 只报一句不透明的 `failed to import`。

**正确做法：打包成 `.tgz` 再装。** 从 tarball 安装时 pnpm 会在 profile 的 `node_modules` 下建**真实目录**，与能正常工作的插件一致，裸包名即可解析。

### tarball 的硬性要求

- **顶层必须是 `package/`。** pnpm 会剥掉一层前导路径；缺 `package/package.json` 会报
  `[ERR_PNPM_INVALID_DEPENDENCY_NAME] Refusing to place a dependency under ... with the invalid alias "<绝对路径>"`。
- `package.json` 必须始终在包内（pnpm 靠它推断依赖别名），即使它不在 `files` 里。

`templates/scripts/pack.mjs` 已经处理好这两点。

### 为什么 dsh 自带的包不写进 `dependencies`

**dsh 随发行版提供的包由 dsh 安装目录解析，所以 bundle 不要声明对它们的依赖。** 官方插件开发契约明确写了这一点。声明了反而会引入版本冲突和 peer 检查失败。

## 陷阱 2：失败按 entry id 缓存

**同一个 entry id 重新安装不会重新 import。** 对已注册的 entry 再跑 `install_bundle` 会直接返回：

```json
{"stage":"install","changed":false,"application":"failed","error":{"code":"ambiguous-install"}}
```

排查时必须**换一个全新的 entry id**（或换包名），否则你会把旧的失败当成新的失败，得出"改了没用"的错误结论。

推论：**做诊断探针时，每个探针都用独立的新包名和 entry id。** 探针是排查这类问题最有效的工具（见下）。

## 陷阱 3：裸包名解析路由在启动时固定，且进程内缓存

这是最隐蔽的一个。表现：**代码完全正确、文件字节一致、profile 里也有正确副本，但正在运行的 DSH 仍然把裸包名解析到旧位置**（例如源码目录），于是报 `ERR_MODULE_NOT_FOUND`。

机制：DSH 给 Node 的模块解析加了一层 `ProfileResolution`，它把每个 `parent` URL 的解析结果**记在进程内的 Map 里**：

- 解析路由表在**启动时**根据 profile 状态编译一次。
- 单个请求的解析结果会**缓存到进程生命周期结束**（ESM 和 CJS 各一份）。
- 唯一的刷新 API 是 `PluginPackages.replace()`，而它在整个 `dsh-app-boot` 里**没有任何调用者**。

**⇒ 改完插件必须重启 DSH 桌面应用。** 重装、改文件、删 junction 都不够。

### 判断是不是这个陷阱

按顺序做，任一步通过就停：

1. **确认 profile 里有真实副本**（不是 junction）：
   ```powershell
   Get-Item "<profile>\node_modules\<pkg>" -Force | Select-Object LinkType, Target, Attributes
   ```
   `LinkType` 为空、`Target` 为空 = 真实目录，正确。

2. **确认源码和 profile 副本字节一致**（逐文件 SHA256 对比）。

3. **确认全新启动会正确解析**：写一个脚本，复刻 DSH 的 `resolveBundleDir`（从安装锚点和 profile 目录分别用 `createRequire(anchor).resolve.paths(name)` 走**真实文件系统**查找，无缓存），确认解析到 profile 副本而不是源码目录。**注意：这是纯文件系统查询，没有进程缓存，所以它代表"重启后的结果"。**

4. **对比一个已知能工作的插件**：对 `createRequire("<profile>/node_modules/<pkg>/lib/index.js").resolve(spec)` 分别测试你的插件和 Trae/Qoder，如果**三者结果完全一致**（该成功的一样成功、该失败的 `MODULE_NOT_FOUND` 一样失败），说明你的解析姿态已经正确，剩下的是进程缓存问题 → **重启**。

如果第 4 步显示你的插件解析结果和正常插件不同，那才是真的安装问题，回到陷阱 1。

## 数据丢失风险（务必遵守）

参考案例中，**插件源码目录曾在一次装/卸 bundle 序列中被静默清空**，原因未查明。

**规则**：

- 开始任何 `install_bundle` / `remove_bundle` 序列之前，**先复制一份源码备份到工作区外**。
- **每一步之后核对源码的文件列表和哈希**，不要等最后一起查。
- 装/卸只通过 `plugin_manager` 做，不要手工删 profile 里的 `node_modules` 条目或改 `dsh.profile.bundles`——手工改会绕过 pnpm 的一致性维护。

## 不要做的事（汇总）

- **不要安装源码目录**（陷阱 1）。
- **不要用同一个 entry id 反复排查**（陷阱 2）。
- 不要试图通过在源码目录放 `node_modules` 来"修好"解析——治标不治本，且掩盖了真实问题。
- 不要相信 `list_plugins`/`list_bundles` 的中间输出（大列表会被裁剪）；用 `cordis_inspect_query`。
- 不要靠 `dsh --profile <name> --dump-config-schema` 之类的 CLI 旗标去 dump 激活错误——桌面版 profile 由 Electron 应用独占管理，CLI 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。
- 不要用服务端日志/终端输出/进程列表判断插件是否生效——只看 `application` + `warnings` + `listConfigs` 的 `status`。

## 陷阱 4：旧 fiber 仍占用 provider 路由

改好重装后如果报 `DUPLICATE_ADAPTER`，说明**旧版本插件注册的 provider 路由还活着**（旧 fiber 未被释放）。这同样只能靠重启清掉。

诊断：查 `listProviders()` 看该 provider 是否已在列表里，以及是否有第二个 provider 行（例如 `llm-officeace` 和 `llm-officeace-2` 同时存在）。

## 诊断探针（强烈推荐）

当 `failed to import` 出现且上面都排除不了时，**装一个最小的探针包**来区分"插件代码问题"和"解析/安装问题"：

探针 = 一个新包名 + 新 entry id + 极简 `apply`，它只做一件事：把关键事实写到一个文本文件。

```js
// 探针 lib/index.js
import fs from "node:fs";
export const name = "dsh-xxx-probe";
export const inject = ["llm"];
export function apply(ctx) {
  const lines = [];
  try {
    lines.push("providers: " + JSON.stringify(ctx.llm.listProviders().map((p) => p.id)));
  } catch (e) { lines.push("providers FAILED: " + e.message); }
  lines.push("entry id: " + (ctx.fiber.entry?.options?.id ?? "<none>"));
  fs.writeFileSync("D:/path/to/_probe.txt", lines.join("\n") + "\n");
}
```

**探针能一次性区分三类问题**：

| 探针结果 | 结论 |
|---|---|
| 探针也 `failed to import` | 解析/安装层问题（陷阱 1 或 3），不是你的插件代码 |
| 探针 applied 且写出了文件 | 安装链路是好的，问题在你的插件代码或 entry id 缓存（陷阱 2） |
| 探针 applied 但 provider 不在列表里 | 注册逻辑问题，或旧 fiber 占着路由（陷阱 4） |

**注意**：探针用自己的 entry id 查真实插件的 `registerModelDiscovery` 会得到 `no model discovery is registered for "<探针 entry id>"`——这是**预期的**，因为 discovery 以 settings namespace 为键。要查真实插件的 discovery，必须用真实插件的 entry id。

探针用完**一定要卸载并删除产物**：每个 `install_bundle` 都会在 profile 里留下 `node_modules` 条目和 `dsh.profile.bundles` 行。

## 验证安装结果

安装后按此顺序确认（详见 `verification.md`）：

1. `application: "applied"` 且 `warnings: []`。
2. `cordis_inspect_query(host, Config, listConfigs, {name: "<pkg>"})` → 条目 `status: "schema"`。
3. `listConfigs {entry: "<entry id>"}` → `packageDir` 指向 **profile 副本**，不是源码目录。
4. 跑真实调用。

`status: "schema"` 是关键信号：之前失败时这里报的就是 `failed to import`。
