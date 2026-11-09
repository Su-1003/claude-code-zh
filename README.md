# claude-code-zh

给 **VS Code 里的 Claude Code 扩展**补中文界面的一套本地汉化工具。

不是语言包插件，也不附带任何 Anthropic 的代码——它只做一件事：把你本机已装好的扩展里**打包进 js 的界面文案**替换成中文，每个文件先备份，改完立刻做语法自检，出错自动回滚。

> 非官方项目，与 Anthropic 无关。Anthropic、Claude 是 Anthropic PBC 的商标。

## 它改什么

扩展的界面文字是写死在三个文件里的字符串字面量：

| 文件 | 内容 |
|---|---|
| `package.json` | 命令标题、设置项说明、入门引导 |
| `webview/index.js` | 侧边栏、会话管理、权限提示、插件市场 |
| `extension.js` | 通知、状态栏、少量提示 |

工具只替换**被引号完整包住的文本**，跳过对象键名、URL、路径、标识符，因此不改代码结构，只换显示文字。

## 用法

需要 Node.js（LTS 即可，不用装依赖）。

**Windows**：双击对应脚本即可

- `扫描.cmd` — 扫描当前版本里还没翻译的界面文案，输出 `scan-report.txt`
- `重新汉化.cmd` — 应用词表并自检（扩展更新后用这个）
- `自检.cmd` — 只在扩展版本变化时才重新汉化，可配成登录时自动执行（`注册开机自检.cmd`）

**命令行**（任意平台，node 可用即可）

```bash
node claude-zh.js status      # 看落地位置、版本、补丁状态
node claude-zh.js scan        # 扫未翻译的界面文案 → scan-report.json/txt
node claude-zh.js apply       # 预览替换（不写入）
node claude-zh.js apply --yes # 写入（自动备份 + 语法自检 + 失败回滚）
node claude-zh.js verify      # 语法自检
node claude-zh.js restore     # 从 .zhbak 完整还原
node claude-zh.js guard       # 仅当扩展版本变化时重新汉化
node claude-zh.js selftest    # 内置样例自检，确认工具本身没坏
```

可选参数：`--dir "<扩展目录>"` 手动指定扩展目录、`--ext-only` / `--cli-only`、`--all-versions`、`--roots "<目录>"`。

## 词表

`zh-dict.json` 是「英文原文 → 中文」的映射，当前 600+ 条：

- 普通条目按**整句精确匹配**；
- 以 `~` 开头的是**片段替换**，用于 `Thought for ${n}s` 这类拼接文案；
- 译文里不能出现引号和反斜杠，片段条目还不能出现 `/ < > ; =`，否则会切断源码里的字符串。

想加词就直接往 `zh-dict.json` 里加一对键值，注意键必须和源码里的字符串**一字不差**（含空格、标点、省略号）。不确定原文长什么样，先跑 `scan` 或 `grep "关键词"`。

## 已知限制

**翻不到的部分**

- CLI 进程或服务端下发的文本：mod 提示（`This mod is now loaded.`）、`No response requested.`、`From the xxx plugin`、模型列表与价格——扩展目录里没有这些字符串。
- 拼接片段（`Yes, allow `、` of output.`）单独翻会语序错乱，默认不翻。
- ajv / Zod / MCP SDK 的 schema 报错属于开发者向文本，故意保留英文便于检索。

**关于 CLI**：新版扩展自带的是 `resources/native-binary/claude.exe`（编译后的二进制），本项目**不碰它**——改二进制会破坏长度偏移，坏了整个扩展都起不来。

**版本敏感**：界面字符串随版本变化，换版本后部分条目会失效（`apply` 会列出没命中的条目）。本项目在 **Claude Code for VS Code 2.1.319** 上实测通过。

**与第三方汉化包冲突**：如果你装过 `zstings.claude-code-zhcn` 之类的整包汉化，请先禁用或卸载，否则两边改同一批文件，`restore` 会对不上账。

## 安全性

- 不联网，不发任何数据。
- 只改显示文本，不动逻辑；每个被改的文件都有 `.zhbak` 备份。
- 每次写入后立刻 `node --check` / JSON 解析，语法不过就当场回滚。
- 已知风险：如果某个字符串同时也被代码当作**跨进程传值**使用，替换后可能对不上（本项目在 2.1.319 上核查过：中文参与 `===` 比较的只有一处，且两侧一致）。

## 许可

工具与词表以 MIT 许可发布。词表中的英文短句仅用于字符串匹配，版权归 Anthropic 所有；本项目不随附、也不再分发扩展本体。
