<div align="center">
<img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/dsh-grok-search-logo.png" alt="dsh-grok-search 多来源搜索 Logo" width="176">

# dsh-grok-search

**在原来的 DSH 聊天里使用多来源搜索，一家出错，自动尝试下一家。**

可视化配置 · 自动回退 · 日志回放 · 账户额度 · GitHub 分段读取

[![Version](https://img.shields.io/badge/Version-0.3.0-5264FF?style=flat-square)](https://github.com/Lain-in-coding/dsh-grok-search/releases) [![DSH](https://img.shields.io/badge/DSH-0.2.1%20rc.2%E2%80%93rc.5%20%7C%200.2.2%20rc.1%E2%80%93rc.2-24292f?style=flat-square)](#支持范围) [![MIT](https://img.shields.io/badge/License-MIT-24292f?style=flat-square)](./LICENSE) [![Stars](https://img.shields.io/github/stars/Lain-in-coding/dsh-grok-search?style=flat-square)](https://github.com/Lain-in-coding/dsh-grok-search/stargazers)

[快速开始](#快速开始) · [更新已有版本](#更新已有版本) · [支持范围](#支持范围) · [来源与排序](#来源与排序)

[搜索日志与额度](#最近搜索与账户额度) · [共享配置](#共享配置) · [隐私与费用](#隐私与费用) · [常见问题](#常见问题)

<a href="https://github.com/Lain-in-coding/dsh-grok-search"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-hero.png" alt="dsh-grok-search 项目封面：Grok 主搜索与四个补充来源，支持静默回退、最近搜索和停用后恢复原搜索" width="960"></a>

</div>

> **v0.3.0**：新增 GitHub 完整读取与聊天搜索卡片，支持 DSH `0.2.2-rc.2`。

`dsh-grok-search` 是 DeepSeek Harness（DSH）的可视化搜索插件，以 [Episkey-G](https://github.com/Episkey-G) 开发的 [grok-search-rs](https://github.com/Episkey-G/GrokSearch-rs) 为 MCP 核心后端，接入 DSH 原有的 `web_search`。照常在聊天里提问，由插件提供 Grok 主搜索与补充来源回退，安装一个 DSH 插件即可。

- **来源自己选**：Grok 主搜索可开可关，Tavily、Exa、TinyFish、Firecrawl 按顺序回退。
- **配置直接填**：在界面填写 Base URL 和 API Key，自动发现已有程序，缺少时下载经验证的版本。
- **已有设置接着用**：共用 `grok-search-rs` 配置，Key 可查看、修改，升级后继续保留。
- **搜索过程看得见**：查看实际结果来源、搜索日志、链路回放与账户额度。
- **一个开关启停**：接管或恢复原搜索，保留网页抓取设置与普通聊天；宿主开启热重载时即时生效。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-intro.png"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-intro.png" alt="功能总览：以 grok-search-rs 为后端接管 DSH 搜索，提供多来源回退、共享配置、最近搜索、链路回放和账户额度" width="960"></a>
</p>

<details>
<summary>名词说明：Grok、Grok Search Rs 和补充来源</summary>

| 名词 | 含义 |
| --- | --- |
| `grok-search-rs` | 本机运行的 MCP 搜索后端，界面名称为「Grok Search Rs」；`0.1.26` 是程序版本 |
| Grok 主搜索 | 使用 xAI Grok 模型的搜索服务；模型版本不是后端程序版本 |
| 补充来源 | Tavily、Exa、TinyFish、Firecrawl；关闭 Grok 后也能单独使用 |
| 回退 | 当前来源失败或返回空结果时，在剩余请求预算内尝试下一个来源 |

</details>

## 界面一览

DeepSeek Harness 与「Grok Search Rs」横向相连，搜索来源在右侧纵向排列。每行只有图标、名称和开关，点击图标或名称即可配置。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-mockup.png"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-mockup.png" alt="0.2.0 深色界面效果图：搜索路由、供应商开关、共享配置入口与最近搜索位于同一详情页" width="960"></a>
  <br><sub>深色界面效果图 · 点击查看大图</sub>
</p>

<table>
  <tr>
    <td width="50%"><a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-route-light.png"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-route-light.png" alt="浅色路由界面：已读取共享配置，Grok、四个补充来源和 GitHub 分组展示" width="100%"></a></td>
    <td width="50%"><a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-route-dark.png"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-route-dark.png" alt="深色路由界面：相同的搜索来源、开关和共享配置入口" width="100%"></a></td>
  </tr>
  <tr>
    <td align="center"><sub>浅色主题 · 点击查看大图</sub></td>
    <td align="center"><sub>深色主题 · 点击查看大图</sub></td>
  </tr>
</table>

图中查询、耗时、测试结果和账户额度用于演示界面，不作为性能、免费额度或实测通过的承诺。

## 准备工作

- **DSH**：`0.2.1-rc.2` ～ `0.2.1-rc.5`、`0.2.2-rc.1` ～ `rc.2`，系统与入口见[支持范围](#支持范围)。DSH `0.2.2-rc.2` 需要插件 `0.3.0`。
- **至少一个搜索 Key**：Grok 或任一补充来源的 API Key；无需全部配置。
- **网络连接**：首次安装要下载依赖；没有兼容的 `grok-search-rs` 时，插件会自动准备程序。

## 快速开始

安装 **0.3.0**：从 [npm](https://www.npmjs.com/package/dsh-grok-search?activeTab=versions) 或 [GitHub Release](https://github.com/Lain-in-coding/dsh-grok-search/releases/tag/v0.3.0) 获取，两种方式任选其一；已安装的用户可直接看[更新已有版本](#更新已有版本)。

### 方式一：在 DSH 中按名称安装

1. 打开 **「插件 → 添加插件」**。
2. 在 **「包名或地址」** 填写下面的名称，阅读来源提示后点击 **「安装」**：

   ```text
   dsh-grok-search
   ```

3. 等待显示 **「已安装」**，确认包名后进入[首次配置](#首次配置)。下载进度可在「查看安装详情」中查看。

若提示已经安装，返回已安装列表打开详情。

**安装指定版本：** 从 npm 发布列表选择所需版本，填写 `dsh-grok-search@版本号`，将“版本号”替换成实际已发布的号码。新版本刚发布时，DSH 的安全等待策略可能让裸包名安装到较早版本；下方录屏以 `dsh-grok-search@0.2.0` 演示，安装后请核对版本，无需关闭安全策略。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-by-name-020-hd.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-by-name-020-hd.png" alt="0.2.0 按名称安装实录：进入 DSH 插件页，添加插件，输入 dsh-grok-search@0.2.0，点击安装，最后显示已安装和版本 0.2.0，不点击启用" width="960"></a>
  <br><sub>Windows Desktop 0.2.2-rc.1 · 已发布插件 0.2.0 · 约 13 秒，下载等待标注 ×8，安装成功即结束。</sub>
  <br><sub>点击动态图观看 1920 像素宽高清 MP4。</sub>
</p>

### 方式二：下载 Release 压缩包后本地导入

适合安装指定版本或安装源尚未同步的情况，**直接导入 `.tgz` 即可，无需解压**。

1. 打开 [GitHub Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases)，在所需版本的 **Assets（附件）** 下载 `dsh-grok-search-<版本>.tgz`。请选择插件包，`Source code` 是源码归档。
2. 复制下载文件的绝对路径。
3. 打开 **「插件 → 添加插件」**，在 **「包名或地址」** 粘贴该路径，不加引号。路径格式如下，`<版本>` 必须换成下载文件的实际版本：

   ```text
   C:\DSH-Plugins\dsh-grok-search-<版本>.tgz
   ```

4. 点击 **「安装」**，看到 **「已安装」** 后继续[首次配置](#首次配置)。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-020-hd.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-020-hd.png" alt="0.2.0 候选包本地导入实录：打开插件页、添加插件、输入 tgz 绝对路径、安装，最后显示已安装和版本 0.2.0，不点击启用" width="960"></a>
  <br><sub>Windows Desktop rc.5 · 0.2.0 候选包本地导入实录 · 约 15 秒，下载等待标注 ×8，安装成功即结束。</sub>
  <br><sub>点击动态图观看 1920 像素宽高清 MP4；这是本地安装演示，不是 npm 按名称安装或 Release 下载实录。</sub>
</p>

<details>
<summary>macOS / Linux 路径、解压目录导入与注意事项</summary>

`.tgz` 文件直接填绝对路径，例如 `/Users/你的用户名/Downloads/dsh-grok-search-<版本>.tgz`，将用户名和版本替换成实际值，不用加 `file:`。路径必须位于运行 DSH 的电脑；远程 Web 不能使用浏览器所在电脑的本地文件路径。

若已经解压，进入内层 `package` 文件夹，确认能直接看到 `package.json`、`cordis.patch.yml` 和 `src`，在同一个输入框填写 **`file:` 加文件夹绝对路径**：

```text
file:C:\DSH-Plugins\dsh-grok-search\package
```

Windows 可在该文件夹按 `Alt+D`、`Ctrl+C` 复制地址。目录前的 `file:` 用于安装依赖；仅填目录路径可能变成开发链接并缺少依赖。请保留解压目录，便于再次导入。

以上示例均需换成实际路径。本地包首次安装仍可能联网下载依赖和 `grok-search-rs`，不是完全离线安装。

</details>

### 首次配置

1. 点击 **「立即启用」**，或打开已安装列表中的插件开关，再进入插件详情。等待 `grok-search-rs` 程序就绪；已有共享配置会自动读取，没有 Key 时显示「等待配置」。
2. 按需配置来源，填好后保存并开启：

   | 使用方式 | 操作 |
   | --- | --- |
   | 只用补充来源 | 关闭 Grok，点击 Tavily、Exa、TinyFish 或 Firecrawl，填写对应 API Key |
   | 使用 Grok 主搜索 | 点击 Grok，填写 API Key；官方接口可保留默认地址，兼容网关按服务商要求选择协议并填写 Base URL 和模型 |

3. 点击 **「测试连接 → 开始测试」**，检查已开启来源的连通性。
4. **确认接管**：回到聊天，发起一个需要联网的问题。出现 `web_search` 后展开搜索步骤，可看到标题为「dsh-grok-search」的卡片，内含实际搜索来源与回退过程。回到插件详情，还能看到对应记录。无需一直开着设置页，也无需在提问时点名插件。

是否发起 `web_search` 由 DSH 的对话与工具调用决定；普通聊天没有触发搜索时，不会产生搜索记录。诊断测试也不写入最近搜索。保存前请了解[共享配置](#共享配置)的影响。

<details>
<summary>观看首次配置演示</summary>

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-first-use.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-first-use.png" alt="0.2.0 首次配置动画：打开 Grok 弹窗，输入遮蔽的演示 Key，保存后来源点亮，状态变为正在接管" width="960"></a>
  <br><sub>0.2.0 生产界面＋离线演示数据 · 点击观看高清 MP4。Key 已遮蔽，可用性以真实测试为准。</sub>
</p>

</details>

<details>
<summary>CLI/Web 命令与安装源说明</summary>

支持范围内的 Linux CLI/Web 可执行：

```shell
dsh plugin --profile web add dsh-grok-search
```

按包名安装使用 npm 的 `latest` 入口。`next` 可能仍指向旧版，不作为更新入口。若镜像尚未同步，在安装弹窗的 **「安装源」** 选择 npm 官方源，或改用 Release 包，无需修改全局 npm 源。「自定义安装源」填写 npm registry（如 `https://registry.npmjs.org/`），不要填写项目的 GitHub 地址。

若只填名称却提示版本不兼容，先看报错中的**实际解析版本**：宿主的新版本等待策略可能仍选到旧包。可从 npm 发布列表选择兼容的精确版本，按 `dsh-grok-search@版本号` 填写，或使用 Release `.tgz`。精确版本仍受宿主安装策略约束，不需要关闭安全检查、卸载现有插件或清缓存。

</details>

## 更新已有版本

**正常更新不用重填 Key、不用清缓存，也不用重新安装兼容的 `grok-search-rs`。** 配置和程序缓存与插件包分开保存；请继续使用原来的 DSH 配置环境，不要清空应用数据。

`0.3.0` 新增控制历史检查点。**降级到旧插件前，须关闭 DSH 并执行当前包提供的离线账本转换**；已生成检查点时，直接安装旧包无法读取新布局。维护工具位于 `src/core/storage-maintenance.mjs`，先 `inspect`，再按返回修订执行 `prepare-downgrade` 和 `activate-downgrade`；中断后用 `recover-downgrade` 恢复。转换不重填 Key、不清程序缓存，原账本会封存保留。该限制不适用于下文已发布的 `0.2.x` 正常更新。回到 `0.2.1` 后若保存插件偏好，再升级到 `0.3.0` 时可能需要重新主动开启 GitHub 读取；共享 Token 不因此删除。

**升级 DSH 前，先确认插件版本支持[目标宿主](#支持范围)。**

DSH `0.2.2-rc.2` 需要插件 `0.3.0`，旧插件 `0.2.1` 不包含该宿主声明。**务必先在兼容的旧宿主把插件更新至 `0.3.0`，再升级 DSH**。若已在 `rc.2` 上仍装着 `0.2.1`，宿主会跳过旧插件；此时更新下载失败，PluginManager 也无法把不兼容的 `0.2.1` 回装为可运行插件。网络恢复后从「添加插件」重新安装兼容的 `0.3.0`；共享 Key、配置和程序缓存不因此清除。**宿主降级与插件降级不同**：rc.2 新写入的具名子代理/团队会话数据可能无法由旧 DSH 读取，插件的账本转换不能转换宿主聊天数据。

**DSH `0.2.2-rc.1` / `rc.2`：优先在插件面板内更新。** 从 npm 按包名安装的用户：

1. 打开 **「插件 → 已安装 → dsh-grok-search」**，**「版本」** 区域会自动检查；需要时点击 **「重新检查」**。
2. 选择兼容版本，点击 **「更新到 …」**，等待更新完成；**不需要手动卸载再安装**。
3. 确认显示的新版本、原有配置和开关；仅在 DSH 提示需要重启时重启。

查不到新版本时，先核对安装源及发布等待提示；不要清缓存或强行忽略兼容检查。本地目录、Git 或 `.tgz` 来源不一定具备此更新入口，可用下面的方式。

<details>
<summary>旧版 DSH 或本地包用户：导入新版 .tgz</summary>

各受支持版本均可直接导入新版 `.tgz`，**不必先卸载旧插件**：

1. 在 [Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases) 确认目标版本已发布且支持你的 DSH，先下载对应 `.tgz`，等待正在进行的搜索结束。
2. 在 **「插件 → 添加插件 → 包名或地址」** 填写新 `.tgz` 的绝对路径，点击 **「安装」**。
3. 安装后若显示 **「立即启用」**，点击启用，否则点击 **「完成」**；从托盘完整退出并重开 DSH，确认版本已更新、原配置仍在。

旧宿主按包名或解压目录安装可能提示“已经安装”，优先改用新版 `.tgz`。确实无法原地更新时，才考虑在插件详情卸载后重新安装；正常卸载保留配置和程序缓存。

</details>

更新失败时，DSH `0.2.2-rc.1` 会尝试恢复旧包，但恢复本身也可能失败。先查看更新结果，必要时用**兼容当前宿主**的已发布 `.tgz` 恢复；不要删除配置或缓存。

## 支持范围

下表列出兼容范围与累计宿主证据；不表示每个候选安装包都已在所有组合重新实测。各版本的验证依据与未覆盖环境见[支持矩阵](./support-matrix.json)。

| 系统 | 入口 | 兼容的 DSH 版本 | 验证情况 |
| --- | --- | --- | --- |
| Windows x64 | Desktop | `0.2.1-rc.2` ～ `rc.5`、`0.2.2-rc.1` ～ `rc.2` | 当前运行代码已在 rc.5、rc.2 官方 ASAR/Electron 隔离验证；旧范围按原证据，0.2.1-rc.4 为源码审查支持 |
| macOS Apple Silicon | Desktop | `0.2.1-rc.2` ～ `rc.5`、`0.2.2-rc.1` ～ `rc.2` | 已有 GitHub 托管 macOS 15 原生宿主证据；最终正文取消修复后未完整复验，0.2.1-rc.4 为源码审查支持 |
| Linux x64（WSL Ubuntu 22.04） | CLI/Web | `0.2.1-rc.2` ～ `rc.5`、`0.2.2-rc.1` ～ `rc.2` | 当前运行代码已在 rc.2 完成隔离安装与首次下载验证；旧范围按原证据 |

- **共用一个安装包**。rc.4 Desktop 的关键宿主源码与已测 rc.3 / rc.5 一致，未单独实测官方 rc.4 桌面发行包。
- **版本分别看**：DSH、DSH Plugin Hub 和 `dsh-grok-search` 各自独立编号，兼容性以本表为准。真正的 DSH `0.1.0` 不在本项目支持范围。
- **区分入口**：Windows/macOS 的独立 CLI/Web 不在本次支持范围；Linux rc.2 使用 WSL Ubuntu 22.04 验证，不等同原生 Linux 实机。
- **操作系统版本**：Windows 11 x64、macOS 15 Apple Silicon、WSL Ubuntu 22.04 是现有验证环境；DSH 版本兼容不等于所有操作系统版本已实测。Windows 10 与原生 Linux 桌面的文件打开尚无实机验证。
- **运行时要求**：DSH `0.2.2-rc.1` / `rc.2` 需要 Node.js ≥ `24.9`；Desktop 自带运行时，CLI/Web 用户须自行满足此要求。插件没有自动升级全局 Node.js。
- **复用已有后端**：已验证 `grok-search-rs` 程序版本为 `0.1.26`；优先复用兼容安装，缺少时准备私有缓存，不升级全局程序或自动采用未经验证的版本。
- **升级 DSH 前核对[支持矩阵](./support-matrix.json)**。超出范围时宿主可能跳过插件、按原设置搜索；表外平台与版本不作兼容承诺。

原生 Linux、真实付费服务等验证边界见[常见问题](#常见问题)。

## 来源与排序

| 来源 | 用途 | 可配置内容 |
| --- | --- | --- |
| Grok | 使用 xAI Grok 模型的主搜索服务 | 接口协议、Base URL、API Key、模型、网页/X 搜索 |
| Tavily | 补充搜索 | Base URL、多个 API Key |
| Exa、Firecrawl | 补充搜索 | Base URL、API Key |
| TinyFish | 补充搜索 | 搜索与抓取 Base URL、API Key |
| GitHub | 官方 API 读取指定 Issue、PR、Release | 默认关闭；公开链接可匿名读取，私有链接需要有权限的 Token；不参与搜索排序 |
| Grok Search Rs 中间节点 | `grok-search-rs` 程序与通用设置 | 补充来源数、回退来源数、超时、缓存、回复字符上限 |

拖动补充来源调整顺序，也支持聚焦后按 `Alt+↑/↓`。**「补充来源数」「回退来源数」指结果条数，不是供应商数量**；设为 4 不表示调用四家。

<details>
<summary>观看排序与切换演示</summary>

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-order.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-order.png" alt="0.2.0 排序与切换动画：将 Exa 拖到 Tavily 前面，关闭 Grok 后路由转向 Exa，再打开 Grok 恢复主搜索" width="960"></a>
  <br><sub>0.2.0 离线演示：拖动排序，再开关 Grok 主搜索 · 点击观看高清 MP4。</sub>
</p>

</details>

## 静默回退

| 场景 | 搜索行为 |
| --- | --- |
| Grok 开启 | 先走主搜索，失败后尝试可用的补充来源 |
| Grok 关闭 | 直接按你排列的补充来源顺序搜索 |
| 来源失败或返回空结果 | 在剩余请求预算内继续尝试，拿到第一份有效结果即停止 |
| 所有来源失败、没有可用来源或预算耗尽 | 明确报错，不自动回到 DeepSeek 官方搜索 |

例如 `Tavily → Exa → TinyFish → Firecrawl`：Tavily 报错、Exa 返回结果，本次搜索便由 Exa 完成。Tavily 有多个 Key 时，遇认证、限流等特定错误还会尝试下一把 Key。回退由故障触发，不主动探测余额，也不会永久跳过某个来源。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-fallback.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-fallback.png" alt="0.2.0 回退演示：Grok 认证失败后短暂红边和轻颤，路由转向 Tavily，最终显示已静默回退" width="960"></a>
  <br><sub>0.2.0 旧版离线示意：展示异常与路由动效，不作为实际搜索回退的证据 · 点击观看高清 MP4。</sub>
</p>

## GitHub 读取与续读

这是 `0.3.0` 的新增功能；已发布的 `0.2.1` 仍只有 Token 与认证检测。

1. 点击 GitHub 图标，阅读权限说明，主动打开「启用读取」并保存。旧版检测开关不会
   自动授权读取。Token 沿用共享 `github_token`；不填写时可匿名读取公开链接。
2. 在聊天中提供具体 Issue、PR 或 Release 链接，请模型读取或完整分析。
   `github_read` 独立于 Grok；获准执行的官方 `web_fetch` 对匹配链接使用同一读取器。
3. 长讨论分段返回原文。完整分析需要模型按返回的游标继续调用，直到没有剩余内容；
   普通问题可以按需续读，回答应披露未读范围。插件无法强迫模型读完。

Issue 包含正文和可访问评论；PR 另包含审查意见、行评论、回复关系与 GitHub 提供的
代码片段；Release 只读发布说明，不下载附件。不读取仓库代码、Discussions 或枚举
私有仓库。原文是不可信外部数据，不作为执行指令。

每次调用最多 30 秒，宿主限制更短时以宿主为准；达到时间、限流或缓存边界时，
返回已读范围与续读位置。正文仅在内存短期保留；每次续读仍需核验 GitHub 权限，
验证失败不交付缓存，Token 错误不改用匿名或第三方抓取。

「最近记录」区分网页搜索与 GitHub 读取，每次工具调用一条，分页不拆记录，续读注明
分段和缓存命中。GitHub 读取不计入搜索次数，回放不联网。私有内容会交给当前聊天模型，
DSH 可能按设置保存包含原文的会话历史；插件日志不保存评论正文或 Token。

## 测试连接

「测试连接」会逐个检查**全部已开启且已配置的搜索来源**和 **Tavily 的每个 Key**，不会因为某个来源成功就跳过其余来源。GitHub 仅在主动开启读取后单独验证认证和少量公开内容，结果与搜索分开；公开测试成功不代表私有仓库权限通过。GitHub 弹窗也可直接测试尚未保存的 Token，取消不写共享配置。

Grok 单项测试不额外调用补充来源，也不修改共享配置；上游未提供明确错误状态时，可能补发一次限时的 Grok 诊断请求。测试显示各来源是否可用；
只有真实搜索发生回退时，才显示「已静默回退」。

测试时显示已完成项、当前来源和等待秒数，可随时点击「停止测试」。每个独立请求遵守共享超时配置和插件预算，整轮逐项测试可能超过两分钟；空结果会明确标注，不当作 Key 失效。

真实搜索共用一次总预算（默认 120 秒，含排队与回收）。有可用备用来源时会预留回退时间，慢来源不会独占插件直接管理的回退窗口；全部未返回可用结果时明确结束，不无限重试，也不自动切到官方付费搜索。上游内部预取仍由 grok-search-rs 管理。

图标点亮表示已配置并开启，Key 可用性以测试结果为准。右上角图标与小圆点显示最近一次测试；出错来源短暂红边、轻颤，并显示简短原因，如 `403 · 访问被拒绝`。

**日常搜索拿到有效结果就停止；测试搜索会逐项检查。** 两者都可能消耗供应商额度，见[隐私与费用](#隐私与费用)。

<details>
<summary>观看逐来源连通性测试</summary>

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-test.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-020-test.png" alt="0.2.0 连通性测试动画：确认测试后依次检查 Grok、全部补充来源与 GitHub，数据沿路由流动，逐项显示结果" width="960"></a>
  <br><sub>0.2.0 离线诊断演示：每个来源与 Key 逐项检查 · 点击观看高清 MP4。</sub>
</p>

</details>

## 最近搜索与账户额度

### 最近搜索：看清结果来自哪里

插件启用后自动记录当前 DSH profile 的搜索。**一个查询一条日志，最多显示最近 20 条**；同一次 `web_search` 中的多个查询分别展示。

- 摘要展示时间、搜索内容、结果、耗时和来源链路；展开查看「服务、调用、结果、消耗」。
- 按成功、回退、失败筛选；点眼睛隐藏内容，点「清空记录」清除。
- **切换页面保留，停用插件或退出 DSH 后清空**，仅存在内存中，不写入磁盘。
- 聊天搜索步骤也会标出实际来源。过期、已清空或无法关联的调用保留原始搜索结果，并显示「本次来源未记录」；连接异常显示简短错误，不推测来源。

**聊天执行卡片**：一条 `web_search` 调用对应一张卡片，多查询在卡片内部区分；
展开可查看 DSH → Grok Search Rs → 实际来源、逐项结果和已记录的耗时，右侧按钮沿用
DSH 的原始参数与结果检查。卡片动效不发起搜索、不消耗额度，也不阻塞结果交付。
每条查询的链路始终横向排列；窗口较窄或来源较多时，可在链路区域内横向滚动，
查看完整节点和状态。

卡片展示已记录的执行明细；重启或清空记录后，部分历史明细可能不可用。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-log-detail.png"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-log-detail.png" alt="最近搜索演示：每个查询独立展示，展开一条回退记录可查看 Grok 失败、Tavily 成功及接口报告的消耗" width="860"></a>
  <br><sub>来源、结果与消耗放在同一条记录中；示例数据不代表真实账户或测试结论。</sub>
</p>

### 链路回放：重新看一遍搜索路径

点击已完成记录的 **「回放」**，上方路由图会重现结果链路。回放只播放动画，**不重新搜索、不消耗额度、不修改配置或 Key 状态**。

内部回退依据 `grok-search-rs` 返回的标签展示实际供应商和官方图标；多来源结果分别展示，缺少标签时显示「来源未报告」。动画表达已知的结果路径，不还原原始网络时序，也不据此推算调用次数、使用的 Key 或费用。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-replay.png" alt="回放结束后的路由界面：已恢复当前配置，保留返回该条日志的入口" width="860">
  <br><sub>回放结束后恢复当前配置，可点击「返回该条日志」继续查看明细。</sub>
</p>

### 账户额度：打开弹窗自动查询

打开已配置的供应商弹窗即自动查询，30 秒内重开复用同一账户缓存，过期后自动刷新；也可以手动刷新。

| 来源 | 可查看内容 |
| --- | --- |
| Tavily | 套餐已用／剩余；当前 Key 限制更低时，在总额度旁提示 |
| Firecrawl | 团队余额 |
| TinyFish | 钱包余额 |
| Exa | 尚未接入普通 Key 余额接口，可从标题旁「服务控制台」查看 |

自定义 Base URL 同样尝试查询；失败时显示原因和已获得的 HTTP 状态，可点击重试，刷新失败时保留并标明上次结果。当前表单的 Base URL 和 Key 无需先保存即可查询，查询不写配置，取消不会保存草稿。「服务控制台」始终打开对应供应商的官方控制台，自定义服务的余额以该服务提供方为准。

**账户额度可能含其他应用的调用，不等于本次搜索消耗。** 日志只展示接口实际报告的消耗，缺失显示「未报告」，说明收在旁边的圆形提示图标中，不按余额差值推算。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-quota-compact.png" alt="Tavily 配置与额度演示：Key 默认遮蔽，账户额度分为已用和剩余，标题行提供 Key 切换与刷新，较低 Key 余量收进总额度旁提示" width="720">
  <br><sub>已用与剩余并列展示；图中 126 / 874 credits 为演示数据，实际额度以服务商返回为准。</sub>
</p>

## 共享配置

本插件与 `grok-search-rs` **读写同一份配置文件**，不另存第二份 DSH Key 配置。

- **位置**：默认在用户目录的 `.config/grok-search-rs/config.toml`，也可由 `GROK_SEARCH_CONFIG` 指定。页底「Grok 共享配置」显示实际位置，支持打开文件、所在文件夹或复制路径。
- **影响范围**：保存 Key、补充来源顺序和开关会修改共享文件。Grok 主搜索与 GitHub 读取开关只对当前 DSH 生效，关闭不删除凭据。
- **生效时机**：保存通常在下一次搜索生效，在途请求保持原配置。正常退出、重开和升级保留已保存的 Key；未保存草稿不写入。其他 MCP 客户端按各自机制重读配置。

> **共享文件的修改也会影响使用它的其他 MCP 客户端。** 配置历史与凭据保护见[隐私与费用](#隐私与费用)。

<details>
<summary>配置冲突、Key 查看与文件入口</summary>

- 保存保留注释和未编辑字段。同一字段被其他窗口修改时，草稿会保留；修改 Key 或 Base URL 遇到新修订也不会自动合并。点击「读取最新配置」，核对后再保存，避免把新 Key 配到尚未确认的地址。
- 已保存到文件的 Key 可继续修改；「环境变量 · 只读」表示启动环境提供了覆盖值，需要在该环境修改或移除，插件不擅改系统环境变量。
- Key 默认遮蔽，可在安全连接下点眼睛查看或点击复制，访问限制见[隐私与费用](#隐私与费用)。
- 远程 Web 页面只提供 **DSH 服务器**上的配置路径，供复制后在宿主查看；不会打开浏览器所在电脑的文件。无桌面 Linux 同样保留路径入口。
- Windows 优先使用已安装的新版记事本，不可用时尝试一次系统经典记事本；无需安装编辑器或设置 TOML 文件关联。macOS 使用默认文本编辑器。始终打开原配置文件，失败会说明原因，不影响已保存的 Key。
- Windows「打开文件夹」使用系统资源管理器，并确认目标目录窗口可见；无法确认时可复制路径手动打开，不会仅因系统接受请求就报告成功。

</details>

## 启停与排错

日常请只使用 DSH 已安装列表里的**插件开关**：关闭即恢复原搜索设置，重新开启由 `dsh-grok-search` 按当前来源设置接管。宿主没有启用热重载时，会提示需要重启。

DSH 的插件开关与详情中的组件开关是两层独立设置。若插件已启用，但组件被单独关闭，请手动将组件重新打开；卸载重装不会清除这条组件设置。

<details>
<summary>遇到报错时，看这里</summary>

| 提示 | 建议操作 |
| --- | --- |
| `401` / Grok 认证失败 | 检查对应服务的 Key 是否正确、过期或被撤销；`grok-search-rs` 未提供 HTTP 状态码时不猜测 |
| `403` | 检查账号、模型或接口权限；不一定是余额不足 |
| `429` | 检查额度和限流，稍后重试 |
| `404` / `405` | 核对 Base URL 与接口路径 |
| 网络 / 超时 / TLS | 检查网络、代理、证书与超时设置，不要关闭证书校验 |
| Grok 未返回引用链接 | 回答没有可识别的来源；核对模型联网能力与接口引用格式，不等于 API Key 无效 |
| `OUTPUT_LIMIT` / 回复上限过小 | 输出预算未能保留搜索链接；在「Grok Search Rs」中调大「回复字符上限」，不等于 Key 失效 |
| `CONFIG_CONFLICT` | 读取最新配置，核对草稿后再保存 |
| `CONFIG_COMMIT_UNCERTAIN` | 先回读确认文件状态，不要反复点击覆盖 |
| 程序准备 / 下载错误 | 在「Grok Search Rs」中间节点查看原因，检查网络后按界面提示重新检测或重新准备 |
| `GROK_CACHE_DAMAGED` / 程序缓存损坏 | 点击「重新准备」，验证成功后自动使用新的私有程序；保留共享配置和 Key，不覆盖全局安装 |

</details>

## 隐私与费用

> **配置历史可能包含明文 Key/Token。** `grok-search/config-history/` 保存修改前的完整配置，删除当前 Key 不会擦除历史中的旧值。`0.3.0` 在保存后维护历史，保留30天、最多20份，立即撤销与恢复目标受保护；长期未操作时过期文件可能暂留。请保护配置与历史文件，不要提交到 Git、上传公开网盘或附在问题反馈中。

- **查询去向**：搜索内容会发送给实际使用的服务或自定义网关；回退时，同一查询可能依次发给多家。
- **设置页访问**：搜索正文、账户额度和明文 Key 仅经已认证的本机直连或 HTTPS 读取。远程 HTTP 只展示脱敏配置，禁止查看、复制、提交明文 Key 或修改服务地址。
- **额度查询**：只请求对应配置地址，不跟随重定向，也不把自定义服务的 Key 转发给官方。
- **费用**：搜索和诊断均可能消耗额度。Grok API 或兼容网关按各自规则计费，聊天订阅不等于免费 API。主搜索可能预取补充来源；失败、超时或取消仍可能产生费用。

## 常见问题

<details>
<summary>Plugin Hub / dsh-market / 按名称安装失败，怎么处理？</summary>

先看报错发生在哪一步：

- **装到了旧版本**：先核对报错中的实际插件版本与宿主兼容性。Hub 或市场目录可能滞后，可改用 **DSH 原生「添加插件」**，填写兼容的已发布版本 `dsh-grok-search@版本号`，使用默认源或 npm 官方源。不要将带版本的名称填进 Hub 的裸包名输入框，也不要关闭安全检查。
- **`Cannot find module ...pnpm/bin/pnpm.mjs`**：DSH 自带安装工具缺失或其路径失效，尚未执行插件代码；改用 Hub、本地目录或 `.tgz` 也依赖它。完整退出 DSH，通过[官方发行页](https://github.com/deepseek-ai/deepseek-harness/releases)修复或重新安装**完整应用程序**，保留现有用户数据目录与 `grok-search-rs` 共享配置。不要仅复制一个 `pnpm.mjs`、清空 `.dsh` 或重配 Key；全局安装 pnpm 也不能补齐该应用内路径。

安装器恢复正常后再重试；仍失败时附上 DSH、Hub、实际插件版本及脱敏错误日志。安装结果以宿主提示为准。

</details>

<details>
<summary>为什么还需要 grok-search-rs？需要再手动安装吗？</summary>

`grok-search-rs` 是由 [Episkey-G](https://github.com/Episkey-G) 开发的独立 MCP 搜索后端；本插件调用它执行 Grok 主搜索，并提供 DSH 原搜索工具接入、可视化配置、补充来源回退、诊断、进程管理和恢复。单独配置 `grok-search-rs` MCP 不会自动接管 DSH 原有的 `web_search`。

通常不用手动安装：已有兼容的 `grok-search-rs` 程序就复用，没有才下载到当前 DSH profile 的私有缓存，不改变其他 Agent 的程序路径或创建第二份 `grok-search-rs` 配置。上游程序新版未经验证时会明确提示，不盲目安装。

一个 DSH 实例串行复用一个受管的 `grok-search-rs` MCP 会话，程序空闲五分钟后退出；最多一个活动查询、十六个排队查询，不会每次搜索都累积一个后台进程。DSH `0.2.2-rc.2` 默认单次可派发十条查询；排队容量有界且不增加上游并发或总等待预算，持续过载时仍会明确报忙。

</details>

<details>
<summary>卸载会删除 Key 和配置吗？</summary>

不会。卸载保留 `grok-search-rs` 共享配置，以及当前 DSH profile 目录下的数据：

| 位置（相对当前 profile） | 内容 |
| --- | --- |
| `grok-search/runtime-cache/` | 下载的 `grok-search-rs` 程序与校验记录 |
| `grok-search/preferences.json` | DSH 主搜索与 GitHub 读取授权，不保存 Key |
| `grok-search/config-history/` | 保存前的完整配置历史，**可能包含明文 Key/Token** |
| `control-intent.records/` | 接管与恢复记录 |

profile 通常位于 `<DSH 主目录>/profiles/<profile 名>`；Desktop 使用 `desktop`，上文 CLI/Web 命令使用 `web`。数据保留与保护说明见[更新已有版本](#更新已有版本)和[隐私与费用](#隐私与费用)。

</details>

<details>
<summary>还有哪些验证边界？</summary>

- **宿主验证**：范围见[支持范围](#支持范围)，自动化使用隔离宿主与合成上游；兼容支持与真实付费接口成功分别记录。
- **最新预发布宿主**：DSH `0.2.2-rc.2` 的 Windows x64 与 macOS arm64 Desktop、WSL Ubuntu 22.04 CLI/Web 均有宿主验证记录；macOS 为正文取消修复前的 GitHub 托管 Apple Silicon 证据，未冒称最终包全平台复验。自动化使用合成上游。
- **尚未完整覆盖**：原生 Linux 安装链路、macOS/Linux 真实付费接口、源码热替换、多文件写入中途崩溃、所有并发组合及 DSH 官方联网网页抓取。
- **事务边界**：本地冲突检查不保证网络文件系统、跨文件事务或断电恢复；备份不是加密。

第三方接口返回 HTTP 200 或普通回答，不一定具备可用的联网搜索来源。欢迎反馈实际使用问题，不承诺表外兼容或零故障。

DSH `0.2.2-rc.1` 在宿主配置重建恰好与搜索派发重叠时，可能拒绝旧工具调用并返回 `UNKNOWN_TOOL`；重建完成后的下一次搜索正常，不会因此偷偷改用官方搜索。插件自己的 Key 保存不要求重启宿主。

</details>

## 开发与反馈

开发建议 **Node.js ≥ 24.9**，与最新支持宿主一致。按锁文件安装依赖，再构建、测试和打包：

```shell
npm ci --ignore-scripts --legacy-peer-deps
npm run build:client
npm run test:all
npm run pack:release
```

`pack:release` 只打包，不会自动构建或测试；请先执行以上命令。
完整浏览器验证、打包与供应链说明见源码仓库的 `docs/开发与验证.md`。

反馈时请附系统、DSH 与插件版本、`grok-search-rs` 程序版本、模型名称（如有）、错误码及复现步骤；**不要附 Key、完整配置或未脱敏路径**。

[提交问题](https://github.com/Lain-in-coding/dsh-grok-search/issues) · [版本说明](https://github.com/Lain-in-coding/dsh-grok-search/releases) · [MIT 许可证](./LICENSE)

用着还行？欢迎点个 [Star](https://github.com/Lain-in-coding/dsh-grok-search)，或通过 Issue 分享建议。

## 致谢

感谢 [Episkey-G](https://github.com/Episkey-G) 创建并维护 [grok-search-rs](https://github.com/Episkey-G/GrokSearch-rs)（[MIT 许可证](https://github.com/Episkey-G/GrokSearch-rs/blob/main/LICENSE)）。这个 Rust 编写的 MCP 搜索后端是本插件 Grok 主搜索能力的基础；我们在其之上提供 DSH 原工具接入、可视化配置、多来源回退和进程管理。

如果你也想在其他 MCP 客户端使用这些能力，欢迎阅读 [grok-search-rs 的使用说明](https://github.com/Episkey-G/GrokSearch-rs#readme)，了解上游的功能与更新。两个项目独立维护。

感谢 [LINUX DO](https://linux.do/) 提供技术交流与开源分享的社区空间。
