# 环境与工具陷阱

上面几份文件讲的是插件本身的坑；这份讲**排查过程本身**的坑。这类坑不写下来，下次会一模一样地重踩一遍——因为它们看起来都像"插件坏了"。

## 1. `cordis_inspect` 的确切名字

**没有 `docs/` 目录可查**，官方契约本身就是 skill。查运行时事实只能靠 `cordis_inspect_*`，但名字必须精确：

| 平台 | provider | 方法 |
|---|---|---|
| host | `Service` | `listService`（`{service}`，省略则给目录） |
| host | `Event` | `listEvents` |
| host | `Config` | `listConfigs` |
| host | `Tool` | `listTools` |
| client | `Service` / `Event` / `Builtin` / `Slots` / `Theme` | `listService` / `listEvents` / `listBuiltins` / `listSubTree` / `listTokens` |

三个具体教训：

- **skill 注册表的 Service 键是复数 `skills`，不是 `skill`。** 用 `{service: "skill"}` 会得到 `no catalogued Service named "skill"`。
- **没有名为 `loader` 的 Service。** 想看 loader entry 用 `Config.listConfigs`，不要去找 `loader`。
- **`Config.listConfigs` 的两个参数语义不同**：`name` 是**包名**（如 `dsh-connect-officeace`），`entry` 是 **`include:<entry id>`**（带 `include:` 前缀，如 `include:llm-officeace-2`）。混淆会得到空结果，然后误判成"插件没加载"。

`listConfigs` 的目录分页 `limit` 是 1–100。**大目录在会话里会被中间裁剪**，判断某条是否存在必须用 `name`/`entry` 精确定位，或老老实实分页——不要看 `list_plugins` 的截断输出下结论。

## 2. 用对 node

DSH 内置的 node 和系统 PATH 上的 node **可能是两个不同版本**（本机实测：PATH 上是 v22.23.2，内置是 v24.21.0）。

```
<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

**写任何探测脚本都用内置 node**，这样运行时行为才和 DSH 一致。用 PATH 上的 node 可能因为版本差异得出错误结论。

关于 `node:sqlite`：**两个版本都有**（v22.23.2 和 v24.21.0 都实测可用，会打一条 `ExperimentalWarning`）。不要因为"版本低"就放弃 SQLite 方案，先实测。`zstdDecompressSync` 在 v24 上可用，读 DSH 的 `.zstd` 会话日志要用它。

## 3. PowerShell 的四个坑

**① `ConvertFrom-Json` 读 UTF-8 中文 JSON 会失败。** `Get-Content -Raw` 会错误解码 UTF-8 中文，然后 JSON 解析报 `传入的对象无效，应为":"或"}"`。**读 JSON 一律用 node 的 `fs.readFileSync`**，不要用 PowerShell。

**② `node -e` 双引号里的 Windows 路径会被吃掉。** 反斜杠在双引号字符串里被当转义符：

```powershell
# 错的：路径被吞
node -e "console.log('D:\document\dsh')"
# 对的：写进 .mjs 文件再跑
```

**规则：只要脚本超过一行或含 Windows 路径，就写成 `.mjs` 文件再 `& $node file.mjs`。**

**③ 大输出打到管道会让 node 挂住。** `console.log` 一个巨大的 JSON 树到 PowerShell 管道，进程会卡死（表现为命令超时后被移到后台）。**把结果 `fs.writeFileSync` 到文件，再用 `Get-Content` 分段读。**

**④ 删除/移动前先解析绝对路径确认。** 这条是通用安全：先 `Test-Path`、把解析后的绝对路径打印出来确认，再执行删除。不要对计算出来的路径直接动手。

## 4. 提取 asar 文件

`app.asar` 不是 zip，是「16 字节头 + JSON 目录 + 内容」：

- **JSON 字节长度在 `u32 @12`**——不是 `@4`，也不是文件尾部。
- JSON 从 **offset 16** 开始；文件内容偏移 = `16 + jsonLength + entry.offset`。
- 目录是**嵌套树**（子节点在 `files` 字段），**顶层只有少数几个 key**，必须递归遍历。
- `entry.offset` 可能是字符串，用 **`Number(child.offset)`**。
- **原生插件（native addon）有 `unpacked: true` 且没有数字 `offset`** → 直接算会得到 `NaN` → `RangeError [ERR_OUT_OF_RANGE] Received NaN`。**遇到 `unpacked` 就跳过**，去 `app.asar.unpacked` 目录拿。

完整配方见 `upstream-recon.md`。

## 5. skill 发现契约（写 skill 时用）

`dsh-skill-filesystem` 的根目录（源码实测）：

| source | 路径 | 说明 |
|---|---|---|
| `project-dsh` | `<项目根>/.dsh/skills` | 需要 `cwd` |
| `project-agents` | `<项目根>/.agents/skills` | 需要 `cwd` |
| `custom` | 配置里的 `customSkillDirs` | preset 常用 |
| `user-dsh` | **`<DSH_HOME>/skills`** | 跨工作空间通用，写个人 skill 用这个 |
| `user-agents` | `<agentsHome>/skills` | 默认 `~/.agents` |
| `bundled` | `bundledSkillDir`（`resources\runtime\office-skills`） | 只读，升级会被覆盖 |

**硬性要求**：

- 发现形式只有两种：`<根>/<名字>/SKILL.md`（目录）或 `<根>/<名字>.md`（扁平文件）。**更深的嵌套不会被发现。**
- 第一行必须是**字面的 `---`**（无 BOM），且要有独立的结束 `---`。
- frontmatter 必须**同时**有 `name` 和 `description`，否则该文件被静默跳过（只留一条 warning：`frontmatter requires name and description`）。
- `name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，否则 `invalid skill name`。
- 调用策略键**必须用小写连字符形式**（`disable-model-invocation`、`user-invocable`）。写成驼峰（`disableModelInvocation`、`modelInvocable`）会**直接抛错**。
- 附加文件（`references/`、`templates/`）放在 skill 目录下没问题，会通过 `resourceBase` 提供。

**写完一定要自己校验一遍**：复刻 `parseFrontmatter` + `discoverRoot` 的规则跑一次，确认 `name`/`description` 齐全、name 过正则、首行是 `---`。这比等加载器报错快得多。

## 6. skill 可见性按 scope 分层（别误判成"skill 写错了"）

`skills` 服务**按 scope 分层**：host 平面/仓库插件注册进 **global 层**，preset 挂载的插件注册进**该 preset 的层**；读取时合并 global 层与当前 scope 链。

**后果**：一个 host 根上下文的**探针插件只能看到 global 层**（实测只看到 4 个 bundled skill），看不到 preset 层的 skill。而 profile 里全局的 `skill-filesystem` / `skill-badge` / `tool-skill` 行都是 **disabled**，真实 skill 发现来自**当前激活 agent preset 的层**。

所以：

- **探针看不到你的 skill ≠ 你的 skill 写错了。** 先确认它是不是被 scope 挡住了。
- `office-docx` 这类 bundled skill 能正常加载，说明加载器本身没问题——因为 `bundled` 是 global 的。
- 判断一个 skill 能不能用，**用 `skill` 工具实际加载**，不要靠探针列表。

## 7. 探针卫生

**每个 `install_bundle` 都会留下痕迹**：profile 的 `node_modules` 条目 **+** `package.json` 里的 `dsh.profile.bundles` 行。

- 探针用完必须 `plugin_manager` `remove_bundle` **并删除产物**，否则 profile 会被越堆越脏。
- 收尾时核对 `dsh.profile.bundles` 是否回到「内置 bundle + 真实插件」的干净列表。
- **装/卸 bundle 前后都要核对插件源码的文件列表和哈希。** 参考案例中源码目录曾被静默清空过一次。
