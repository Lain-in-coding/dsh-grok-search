<div align="center">

# dsh-grok-search

**在原来的 DSH 聊天里使用多来源搜索，一家出错，自动尝试下一家。**

可视化配置 · 自动回退 · 日志回放 · 账户额度

[![Version](https://img.shields.io/badge/Version-0.2.0-5264FF?style=flat-square)](https://github.com/Lain-in-coding/dsh-grok-search/releases) [![DSH](https://img.shields.io/badge/DSH-0.2.1%20rc.2%E2%80%93rc.5%20%7C%200.2.2%20rc.1-24292f?style=flat-square)](#支持范围) [![MIT](https://img.shields.io/badge/License-MIT-24292f?style=flat-square)](./LICENSE) [![Stars](https://img.shields.io/github/stars/Lain-in-coding/dsh-grok-search?style=flat-square)](https://github.com/Lain-in-coding/dsh-grok-search/stargazers)

[快速开始](#快速开始) · [更新已有版本](#更新已有版本) · [支持范围](#支持范围) · [来源与排序](#来源与排序)

[搜索日志与额度](#最近搜索与账户额度) · [共享配置](#共享配置) · [隐私与费用](#隐私与费用) · [常见问题](#常见问题)

<a href="https://github.com/Lain-in-coding/dsh-grok-search"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-hero.png" alt="dsh-grok-search 项目封面：Grok 主搜索与四个补充来源，支持静默回退、最近搜索和停用后恢复原搜索" width="960"></a>

</div>

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
| 补充来源数 / 回退来源数 | 界面中的结果条数设置，不是启用的供应商数量 |

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

- **DSH**：`0.2.1-rc.2` ～ `0.2.1-rc.5` 或 `0.2.2-rc.1`，系统与入口见[支持范围](#支持范围)。
- **至少一个搜索 Key**：Grok 或任一补充来源的 API Key；无需全部配置。
- **网络连接**：首次安装要下载依赖；没有兼容的 `grok-search-rs` 时，插件会自动准备程序。

## 快速开始

两种方式任选其一。可下载版本以 [Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases) 为准；已安装的用户可直接看[更新已有版本](#更新已有版本)。

### 方式一：在 DSH 中按名称安装

1. 打开 **「插件 → 添加插件」**。
2. 在 **「包名或地址」** 填写下面的名称，阅读来源提示后点击 **「安装」**：

   ```text
   dsh-grok-search
   ```

3. 等待显示 **「已安装」**，确认包名后进入[首次配置](#首次配置)。下载进度可在「查看安装详情」中查看。

按完整包名即可定位安装，无需从搜索结果中挑选。若提示已经安装，返回已安装列表打开详情。

**安装指定版本：** 填写 `dsh-grok-search@0.2.0`。新版本刚发布时，DSH 的安全等待策略可能让裸包名安装到较早版本；下方录屏使用「包名@版本」，安装后请核对显示的版本号，无需关闭安全策略。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-by-name-020-hd.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-by-name-020-hd.png" alt="0.2.0 按名称安装实录：进入 DSH 插件页，添加插件，输入 dsh-grok-search@0.2.0，点击安装，最后显示已安装和版本 0.2.0，不点击启用" width="960"></a>
  <br><sub>Windows Desktop 0.2.2-rc.1 · 已发布插件 0.2.0 · 约 13 秒，下载等待标注 ×8，安装成功即结束。</sub>
  <br><sub>点击动态图观看 1920 像素宽高清 MP4。</sub>
</p>

### 方式二：下载 Release 压缩包后本地导入

适合安装指定版本或安装源尚未同步的情况，**直接导入 `.tgz` 即可，无需解压**。

1. 打开 [GitHub Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases)，在所需版本的 **Assets（附件）** 下载 `dsh-grok-search-<版本>.tgz`。请选择插件包，`Source code` 是源码归档。
2. 复制下载文件的绝对路径。
3. 打开 **「插件 → 添加插件」**，在 **「包名或地址」** 粘贴该路径，不加引号。例如：

   ```text
   C:\DSH-Plugins\dsh-grok-search-0.2.0.tgz
   ```

4. 点击 **「安装」**，看到 **「已安装」** 后继续[首次配置](#首次配置)。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-020-hd.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-020-hd.png" alt="0.2.0 候选包本地导入实录：打开插件页、添加插件、输入 tgz 绝对路径、安装，最后显示已安装和版本 0.2.0，不点击启用" width="960"></a>
  <br><sub>Windows Desktop rc.5 · 0.2.0 候选包本地导入实录 · 约 15 秒，下载等待标注 ×8，安装成功即结束。</sub>
  <br><sub>点击动态图观看 1920 像素宽高清 MP4；这是本地安装演示，不是 npm 按名称安装或 Release 下载实录。</sub>
</p>

<details>
<summary>macOS / Linux 路径、解压目录导入与注意事项</summary>

`.tgz` 文件直接填绝对路径，例如 `/Users/你的用户名/Downloads/dsh-grok-search-0.2.0.tgz`，不用加 `file:`。路径必须位于运行 DSH 的电脑；远程 Web 不能使用浏览器所在电脑的本地文件路径。

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

3. 点击 **「测试搜索 → 开始测试」**，检查已开启来源的连通性。
4. **确认接管**：回到聊天，发起一个需要联网的问题。出现 `web_search` 后展开搜索步骤，查看「由 dsh-grok-search 执行 · 实际来源」；回到插件详情，还能看到对应的「最近搜索」记录。无需一直开着设置页，也无需在提问时点名插件。

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

按包名安装使用 npm 的 `latest` 入口；`next` 为同版本入口。若镜像尚未同步，在安装弹窗的 **「安装源」** 选择 npm 官方源，或改用 Release 包，无需修改全局 npm 源。

</details>

## 更新已有版本

**正常更新不用重填 Key、不用清缓存，也不用重新安装兼容的 `grok-search-rs`。** 配置和程序缓存与插件包分开保存；请继续使用原来的 DSH 配置环境，不要清空应用数据。

**准备升级到 DSH `0.2.2-rc.1`？先把插件更新到 `0.2.0`，再更新 DSH。** 若已经更新 DSH，直接安装新版插件即可；旧插件 `0.1.1` 不支持该宿主，不要通过忽略版本检查强行启用。

DSH `0.2.2-rc.1` 已提供第三方插件更新入口：从 npm 按包名安装的插件，可在插件管理页检查更新并选择新版本。镜像未同步时可改用下面的 Release 安装包；无需修改全局 npm 源。

各受支持版本通用的方式是直接导入新版 `.tgz`，**不必先卸载旧插件**：

1. 在 [Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases) 确认目标版本已发布且支持你的 DSH，先下载对应 `.tgz`，等待正在进行的搜索结束。
2. 在 **「插件 → 添加插件 → 包名或地址」** 填写新 `.tgz` 的绝对路径，点击 **「安装」**。
3. 安装后若显示 **「立即启用」**，点击启用，否则点击 **「完成」**；从托盘完整退出并重开 DSH，确认版本已更新、原配置仍在。

按包名或解压目录安装时，DSH 可能提示“已经安装”；此时先在插件详情中卸载，再安装新版即可，配置和程序缓存仍保留。若升级失败，可用原版本 `.tgz` 恢复，不要通过删除配置或缓存排障。

Windows Desktop `0.2.1-rc.2/.3/.5` 已验证 `0.1.1 → 0.2.0` 配置保留；另验证了“rc.5 更新插件 → 更新宿主到 0.2.2-rc.1 → 回退”的隔离流程。其他入口的升级路径尚未逐项验证。新版插件包需要下载，已有兼容的搜索程序继续复用。

## 支持范围

| 系统 | 入口 | 兼容的 DSH 版本 | 验证情况 |
| --- | --- | --- | --- |
| Windows x64 | Desktop | `0.2.1-rc.2` ～ `rc.5`、`0.2.2-rc.1` | rc.2 / rc.3 / rc.5 与 0.2.2-rc.1 已测；rc.4 源码审查支持 |
| macOS Apple Silicon | Desktop | `0.2.1-rc.2` ～ `rc.5`、`0.2.2-rc.1` | rc.2 / rc.3 / rc.5 与 0.2.2-rc.1 已测；rc.4 源码审查支持 |
| Linux x64（WSL Ubuntu 22.04） | CLI/Web | `0.2.1-rc.2` ～ `rc.5`、`0.2.2-rc.1` | 五个版本均已测 |

- **共用一个安装包**。rc.4 Desktop 的关键宿主源码与已测 rc.3 / rc.5 一致，未单独实测官方 rc.4 桌面发行包。
- **区分入口**：Windows/macOS 的独立 CLI/Web 不在本次支持范围；Linux 使用 WSL 验证，macOS 使用自动化测试环境。
- **运行时要求**：DSH `0.2.2-rc.1` 需要 Node.js ≥ `24.9`；Desktop 自带运行时，CLI/Web 用户须自行满足此要求。插件没有自动升级全局 Node.js。
- **复用已有后端**：已验证 `grok-search-rs` 程序版本为 `0.1.26`；优先复用兼容安装，缺少时准备私有缓存，不升级全局程序或自动采用未经验证的版本。
- **升级 DSH 前核对[支持矩阵](./support-matrix.json)**。超出范围时宿主可能跳过插件、按原设置搜索；表外平台与版本不作兼容承诺。

原生 Linux、真实付费服务等验证边界见[常见问题](#常见问题)。

## 来源与排序

每行只保留图标、名称和开关，点击图标或名称打开配置弹窗。

| 来源 | 用途 | 可配置内容 |
| --- | --- | --- |
| Grok | 使用 xAI Grok 模型的主搜索服务 | 接口协议、Base URL、API Key、模型、网页/X 搜索 |
| Tavily | 补充搜索 | Base URL、多个 API Key |
| Exa、Firecrawl | 补充搜索 | Base URL、API Key |
| TinyFish | 补充搜索 | 搜索与抓取 Base URL、API Key |
| GitHub | 专用链接解析与认证检测 | Token；不参与补充搜索排序 |
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
  <br><sub>0.2.0 离线诊断演示：主搜索失败后静默回退，逐项展示结果 · 点击观看高清 MP4。</sub>
</p>

## 测试搜索

「测试搜索」会逐个检查**全部已开启的来源**和 **Tavily 的每个 Key**，不会因为某个来源成功就跳过其余来源。GitHub 单独检测认证或匿名访问，不参与补充搜索。

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
- 聊天搜索步骤也会标出实际来源。过期、已清空或无法关联的调用显示「本次来源未记录」。

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

自定义 Base URL 同样尝试查询，查不到显示「额度查询失败」，可点击重试；刷新失败时保留并标明上次结果。「服务控制台」始终打开对应供应商的官方控制台，自定义服务的余额以该服务提供方为准。

**账户额度可能含其他应用的调用，不等于本次搜索消耗。** 日志只展示接口实际报告的消耗，缺失显示「未报告」，说明收在旁边的圆形提示图标中，不按余额差值推算。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-020-quota-compact.png" alt="Tavily 配置与额度演示：Key 默认遮蔽，账户额度分为已用和剩余，标题行提供 Key 切换与刷新，较低 Key 余量收进总额度旁提示" width="720">
  <br><sub>已用与剩余并列展示；图中 126 / 874 credits 为演示数据，实际额度以服务商返回为准。</sub>
</p>

## 共享配置

本插件与 `grok-search-rs` **读写同一份配置文件**，不另存第二份 DSH Key 配置。

- **位置**：默认在用户目录的 `.config/grok-search-rs/config.toml`，也可由 `GROK_SEARCH_CONFIG` 指定。页底「Grok 共享配置」显示实际位置，支持打开文件、所在文件夹或复制路径。
- **影响范围**：保存 Key、补充来源顺序和开关会修改共享文件。Grok 主搜索与 GitHub 检测开关只对当前 DSH 生效，关闭不删除凭据。
- **生效时机**：保存通常在下一次搜索生效，在途请求保持原配置。正常退出、重开和升级保留已保存的 Key；未保存草稿不写入。其他 MCP 客户端按各自机制重读配置。

> **共享文件的修改也会影响使用它的其他 MCP 客户端。** 配置历史与凭据保护见[隐私与费用](#隐私与费用)。

<details>
<summary>配置冲突、Key 查看与文件入口</summary>

- 保存保留注释和未编辑字段。同一字段被其他窗口修改时，草稿会保留；修改 Key 或 Base URL 遇到新修订也不会自动合并。点击「读取最新配置」，核对后再保存，避免把新 Key 配到尚未确认的地址。
- 已保存到文件的 Key 可继续修改；「环境变量 · 只读」表示启动环境提供了覆盖值，需要在该环境修改或移除，插件不擅改系统环境变量。
- Key 默认遮蔽，可在安全连接下点眼睛查看或点击复制，访问限制见[隐私与费用](#隐私与费用)。
- 远程 Web 页面打开的是 **DSH 服务器**上的文件，不是浏览器所在电脑的文件；无法打开时可以复制路径。

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
| `CONFIG_CONFLICT` | 读取最新配置，核对草稿后再保存 |
| `CONFIG_COMMIT_UNCERTAIN` | 先回读确认文件状态，不要反复点击覆盖 |
| `CONFIG_BUSY` / `PREFERENCES_BUSY` | 检查并发保存或上次中断；插件不会强抢遗留锁 |
| 程序准备 / 下载错误 | 检查网络或 `grok-search-rs` 程序缓存，在「Grok Search Rs」中间节点查看原因并重新检测；不会覆盖全局程序 |
| `GROK_VERSION_UNVERIFIED` /「Grok 版本未经验证」 | 指 `grok-search-rs` 程序版本，不是 Grok 模型版本；未经插件验证不会自动安装、升级或覆盖，请等待插件更新 |

</details>

## 隐私与费用

> **配置历史可能包含明文 Key/Token。** `grok-search/config-history/` 保存修改前的完整配置，删除当前 Key 不会擦除历史中的旧值。请保护配置与历史文件，不要提交到 Git、上传公开网盘或附在问题反馈中。

- **查询去向**：搜索内容会发送给实际使用的服务或自定义网关；回退时，同一查询可能依次发给多家。
- **设置页访问**：搜索正文、账户额度和明文 Key 仅经已认证的本机直连或 HTTPS 读取。远程 HTTP 只展示脱敏配置，禁止查看、复制、提交明文 Key 或修改服务地址。
- **额度查询**：只请求对应配置地址，不跟随重定向，也不把自定义服务的 Key 转发给官方。
- **费用**：搜索和诊断均可能消耗额度。Grok API 或兼容网关按各自规则计费，聊天订阅不等于免费 API。主搜索可能预取补充来源；失败、超时或取消仍可能产生费用。

## 常见问题

<details>
<summary>为什么还需要 grok-search-rs？需要再手动安装吗？</summary>

`grok-search-rs` 是由 [Episkey-G](https://github.com/Episkey-G) 开发的独立 MCP 搜索后端；本插件调用它执行 Grok 主搜索，并提供 DSH 原搜索工具接入、可视化配置、补充来源回退、诊断、进程管理和恢复。单独配置 `grok-search-rs` MCP 不会自动接管 DSH 原有的 `web_search`。

通常不用手动安装：已有兼容的 `grok-search-rs` 程序就复用，没有才下载到当前 DSH profile 的私有缓存，不改变其他 Agent 的程序路径或创建第二份 `grok-search-rs` 配置。上游程序新版未经验证时会明确提示，不盲目安装。

一个 DSH 实例串行复用一个受管的 `grok-search-rs` MCP 会话，程序空闲五分钟后退出；最多一个活动查询、八个排队查询，不会每次搜索都累积一个后台进程。

</details>

<details>
<summary>卸载会删除 Key 和配置吗？</summary>

不会。卸载保留 `grok-search-rs` 共享配置，以及当前 DSH profile 目录下的数据：

| 位置（相对当前 profile） | 内容 |
| --- | --- |
| `grok-search/runtime-cache/` | 下载的 `grok-search-rs` 程序与校验记录 |
| `grok-search/preferences.json` | DSH 主搜索/GitHub 检测开关，不保存 Key |
| `grok-search/config-history/` | 保存前的完整配置历史，**可能包含明文 Key/Token** |
| `control-intent.records/` | 接管与恢复记录 |

profile 通常位于 `<DSH 主目录>/profiles/<profile 名>`；Desktop 使用 `desktop`，上文 CLI/Web 命令使用 `web`。数据保留与保护说明见[更新已有版本](#更新已有版本)和[隐私与费用](#隐私与费用)。

</details>

<details>
<summary>还有哪些验证边界？</summary>

- **宿主验证**：范围见[支持范围](#支持范围)，自动化使用隔离宿主与合成上游；兼容支持与真实付费接口成功分别记录。
- **真实服务**：开发期间 Windows 曾验证四个补充来源、三家账户额度与 GitHub 认证；最终复核时部分现有 Key 失效，仅 Firecrawl 回退成功，不能沿用历史成功证明当前 Key 可用。Grok 主搜索人工通过来自 0.1.x；此后的第三方网关未返回可核验引用，补充来源回退不算主搜索通过。
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

`pack:release` 使用 `npm pack --ignore-scripts`，不会触发 `prepack`，因此构建和测试需要单独执行。产物与校验回执位于 `artifacts/release-package/<运行编号>/`；打包不等于发布。文档图片和录制脚本不随 npm 插件包分发。

反馈时请附系统、DSH 与插件版本、`grok-search-rs` 程序版本、模型名称（如有）、错误码及复现步骤；**不要附 Key、完整配置或未脱敏路径**。

[提交问题](https://github.com/Lain-in-coding/dsh-grok-search/issues) · [版本说明](https://github.com/Lain-in-coding/dsh-grok-search/releases) · [MIT 许可证](./LICENSE)

用着还行？欢迎点个 [Star](https://github.com/Lain-in-coding/dsh-grok-search)，或通过 Issue 分享建议。

## 致谢

感谢 [Episkey-G](https://github.com/Episkey-G) 创建并维护 [grok-search-rs](https://github.com/Episkey-G/GrokSearch-rs)（[MIT 许可证](https://github.com/Episkey-G/GrokSearch-rs/blob/main/LICENSE)）。这个 Rust 编写的 MCP 搜索后端是本插件 Grok 主搜索能力的基础；我们在其之上提供 DSH 原工具接入、可视化配置、多来源回退和进程管理。

如果你也想在其他 MCP 客户端使用这些能力，欢迎阅读 [grok-search-rs 的使用说明](https://github.com/Episkey-G/GrokSearch-rs#readme)，了解上游的功能与更新。两个项目独立维护。

感谢 [LINUX DO](https://linux.do/) 提供技术交流与开源分享的社区空间。
