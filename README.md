<div align="center">

# dsh-grok-search

**在 DeepSeek Harness 里配置、切换和使用多来源搜索。**

多来源自动回退 · Grok 主搜索可选 · 可视化共享配置 · 一个插件

[![Version](https://img.shields.io/badge/Version-0.1.1-5264FF?style=flat-square)](https://github.com/Lain-in-coding/dsh-grok-search/releases) [![MIT](https://img.shields.io/badge/License-MIT-24292f?style=flat-square)](./LICENSE) [![DSH](https://img.shields.io/badge/DSH-0.2.1%20rc.2%20%E2%80%93%20rc.5-24292f?style=flat-square)](#支持范围)

[界面一览](#界面一览) · [快速开始](#快速开始) · [来源与排序](#来源与排序) · [测试搜索](#测试搜索) · [共享配置](#共享配置) · [常见问题](#常见问题)

<img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-route-light.png" alt="搜索路由界面：DeepSeek Harness 与 Grok Search RS 横向连接，Grok、Tavily、Exa、Firecrawl、TinyFish 和 GitHub 纵向排列" width="960">

</div>

`dsh-grok-search` 是 DeepSeek Harness（DSH）的可视化搜索插件，以 [Episkey-G](https://github.com/Episkey-G) 开发的 [grok-search-rs](https://github.com/Episkey-G/GrokSearch-rs) 为 MCP 核心后端，为 DSH 原有的 `web_search` 提供 Grok 主搜索与补充来源回退。你仍在原来的聊天里搜索，不用换一套工具，也不用安装第二个 DSH 插件。

文中的 **`grok-search-rs`** 指本机运行的 MCP 搜索后端程序，**Grok 主搜索**指使用 xAI Grok 模型的搜索服务，两者不是同一个概念。`0.1.26` 是 `grok-search-rs` 的程序版本，不是 Grok 模型版本。

- **搜索来源可选，故障自动回退。** 按你设定的顺序尝试备用来源，也可以关闭 Grok 主搜索，直接使用补充来源。
- **装好后在界面里配置。** 自动发现已有 `grok-search-rs` 程序和配置；没有程序时，下载经验证的版本到插件缓存。无需编辑 `cordis.patch.yml` 或手填路径。
- **已有配置不用重填。** 直接读写同一份 `grok-search-rs` 配置，可查看 Key、调整顺序、检查连通性。
- **启停不绕路。** 用 DSH 插件开关接管或恢复原搜索，保留原网页抓取设置与普通聊天。宿主开启热重载时无需重启；关闭热重载时按宿主提示操作。

## 界面一览

插件在 DSH 的插件详情页提供一张「搜索路由」卡片：DeepSeek Harness 与 `grok-search-rs` 程序节点横向相连，搜索来源纵向排列。界面中的 **「Grok Search RS」** 是程序节点，右侧 **「Grok」** 是主搜索服务；点击任一来源或中间节点即可配置。

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-desktop-fallback.png" alt="真实 Windows Desktop 中的插件详情页：Grok 和多个补充来源出错，搜索已静默回退到 Exa" width="100%"></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/readme-sources-only-dark.png" alt="深色主题：关闭 Grok 后由补充来源接管，并读取了已有的共享配置" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><sub>Windows Desktop：多来源搜索回退界面</sub></td>
    <td align="center"><sub>深色主题：只用补充来源，已有配置自动读取，无需重填</sub></td>
  </tr>
</table>

## 支持范围

| 系统 | 入口 | 本版本兼容范围 | 验证情况 |
| --- | --- | --- | --- |
| Windows x64 | Desktop | `0.2.1-rc.2` ～ `0.2.1-rc.5` | rc.2 / rc.3 / rc.5 已测；rc.4 源码审查支持 |
| macOS Apple Silicon | Desktop | `0.2.1-rc.2` ～ `0.2.1-rc.5` | rc.2 / rc.3 / rc.5 已测；rc.4 源码审查支持 |
| Linux x64（WSL Ubuntu 22.04） | CLI/Web | `0.2.1-rc.2` ～ `0.2.1-rc.5` | 四个版本均已测 |

**所有组合共用一个安装包。** rc.4 Desktop 已纳入兼容支持：关键宿主源码与已测 rc.3 / rc.5 一致，但未单独实测官方 rc.4 桌面发行包；支持范围与实测记录分别披露。Linux 在 WSL Ubuntu 22.04 上验证，macOS 在自动化测试环境中验证。作者已在 Windows 上用真实 Key 实测 Grok 主搜索返回结果；macOS 与 Linux 尚未做真实付费接口验收。

`0.1.1` 包含 rc.4 Desktop 兼容声明、rc.5 验证和安全/回退修复，实际发布状态以 [Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases) 为准。**Desktop 与独立 CLI/Web 是不同入口**：Windows/macOS 的独立 CLI/Web 不在本次支持范围。原生 Linux（非 WSL）的完整安装链路仍属验证有限，不将 WSL 通过等同于所有 Linux 环境通过。

`grok-search-rs` 已验证程序版本为 `0.1.26`。插件优先复用兼容的已有程序，不升级全局安装，也不自动采用未经验证的 `grok-search-rs` 新版本。表外平台、入口和 DSH 新版本不作兼容承诺，升级前请核对[支持矩阵](./support-matrix.json)。

## 快速开始

两种安装方式任选其一，所有系统共用一个插件包。名称安装视频录于 Windows Desktop `0.2.1-rc.3`，使用已发布插件 `0.1.0`；已精剪并加速等待画面，到「已安装」为止，实际耗时以本机为准。

### 方式一：在 DSH 中按名称安装

1. 打开 DeepSeek Harness，点击左侧 **「插件」**。
2. 点击右上角 **「添加插件」**，在 **「包名或地址」** 输入框中填写：

   ```text
   dsh-grok-search
   ```

3. 确认包名拼写无误，阅读来源提示，点击 **「安装」**。DSH 会查询安装源，显示目标插件的名称、说明和版本，并开始下载。
4. 等待安装进度完成，不要反复点击安装；需要排查时可以展开 **「查看安装详情」** 查看下载过程。
5. 看到 **「已安装」**，并确认插件名为 `dsh-grok-search`，安装即完成。启用与 Key 配置见下方[首次配置](#首次配置)。

> 这里是按完整包名定位安装，不是先在搜索结果列表中选择。实录 rc.3 与已核对的 rc.5 都使用「包名或地址」输入框。若提示已经安装，直接返回已安装列表打开详情即可。

<p align="center">
  <a href="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-by-name.mp4"><img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/install-by-name.gif" alt="按名称安装精剪：打开插件页，输入 dsh-grok-search，点击安装，显示已安装后结束" width="960"></a>
</p>

### 方式二：下载 Release 压缩包后本地导入

适合需要安装指定版本，或安装源尚未同步的情况。以下以 Windows 为例：

1. 打开项目的 **[GitHub Releases](https://github.com/Lain-in-coding/dsh-grok-search/releases)**，进入所需的已发布版本，展开页面底部的 **Assets（附件）**。
2. 下载 **`dsh-grok-search-<版本>.tgz`**。不要下载 GitHub 自动生成的 `Source code (zip)` 或 `Source code (tar.gz)`，它们是源码归档，不是本教程使用的插件包。
3. 用支持 `.tgz` 的解压工具解压到一个固定目录；如果先得到 `.tar` 文件，再解压一次。打开内层 **`package`** 文件夹，确认能直接看到 `package.json`、`cordis.patch.yml` 和 `src`。
4. 在资源管理器中进入这个 `package` 文件夹，按 **`Alt+D`** 选中地址栏，再按 **`Ctrl+C`** 复制文件夹的绝对路径。例如：

   ```text
   C:\DSH-Plugins\dsh-grok-search\package
   ```

   这只是示例，必须替换为你实际解压的位置。不要复制上一级目录，也不要把 `package.json` 文件本身的路径填进去。

5. 返回 DSH，打开 **「插件 → 添加插件」**，在 **「包名或地址」** 中先输入 **`file:`**，再粘贴刚复制的路径，不要带首尾引号。例如：

   ```text
   file:C:\DSH-Plugins\dsh-grok-search\package
   ```

   **目录路径前的 `file:` 不要省略。** 它让 DSH 同时安装插件依赖；只填目录路径可能变成开发用链接，出现缺少 `smol-toml` 等依赖、插件无法加载的错误。本地导入也使用这个入口，没有单独的「本地导入」按钮。

6. 点击 **「安装」**，看到 **「已安装」** 即完成导入，再按下方[首次配置](#首次配置)启用。

请保留解压目录，便于后续重新导入。路径必须属于运行 DSH 的电脑；远程 CLI/Web 不能直接使用浏览器所在电脑的本地路径。

不想解压时，也可以在同一个输入框中直接填写已下载 `.tgz` 文件的绝对路径。安装包虽然在本地，首次安装所需依赖和 `grok-search-rs` 程序仍可能需要联网下载，不等于完全离线安装。

### 首次配置

1. 点击 **「立即启用」**，或打开已安装列表中的插件开关，再进入 `dsh-grok-search` 详情。确认「搜索路由」卡片出现、组件显示「运行中」，等待 `grok-search-rs` 程序就绪。已有共享配置会直接显示；没有 Key 时显示「等待配置」属正常状态。
2. 选择一种起步方式：

   - **只用补充来源：** 关闭 Grok 主搜索，点击 Tavily、Exa、TinyFish 或 Firecrawl，填写对应 Key，保存并开启。配置多家后可拖动排序。
   - **使用 Grok 主搜索：** 点击 Grok 一行，填写 API Key 并保存。xAI 官方接口保留默认地址即可；使用兼容网关时，选择对应协议并填写服务商提供的地址、Key 和模型。

3. 点击 **「测试搜索 → 开始测试」**，确认 Key 可用。之后直接在 DSH 聊天里提需要联网的问题。

你不需要为每个来源都准备 Key。开启 Grok 主搜索时也可以保留补充来源作为备用；Grok API 或兼容网关的费用另计，不能把聊天订阅或网页免费使用等同于免费 API。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-first-use.png" alt="首次配置动画：打开 Grok 弹窗，输入遮蔽的演示 Key，保存后来源点亮，状态变为正在接管" width="960">
  <br><sub>点击 Grok，填写 Key 并保存，来源点亮，状态变为「正在接管」。</sub>
</p>

<details>
<summary>CLI/Web 命令与安装源说明</summary>

CLI/Web 可执行：

```shell
dsh plugin --profile web add dsh-grok-search
```

直接输入包名使用 npm 的默认安装入口 `latest`；`next` 为同版本入口。若镜像尚未同步，可在安装弹窗的 **「安装源」** 中选择 npm 官方源，或使用上方 Release 本地导入方式，不必修改全局 npm 源。下载 `grok-search-rs` 程序和调用搜索服务都需要联网。

</details>

## 来源与排序

每行只保留图标、名称和开关，点击图标或名称打开配置弹窗。

| 来源 | 用途 | 可配置内容 |
| --- | --- | --- |
| Grok | 使用 xAI Grok 模型的主搜索服务 | 接口协议、Base URL、API Key、模型、网页/X 搜索 |
| Tavily | 补充搜索 | Base URL、多个 API Key |
| Exa、Firecrawl | 补充搜索 | Base URL、API Key |
| TinyFish | 补充搜索 | 搜索与抓取 Base URL、API Key |
| GitHub | 专用链接解析与认证检测 | Token；不参与补充搜索排序 |
| Grok Search RS 中间节点 | `grok-search-rs` 程序与通用设置 | 补充来源数、回退来源数、超时、缓存、回复字符上限 |

拖动补充来源可以调整顺序，也支持聚焦后按 `Alt+↑/↓`。普通回退搜索在第一个返回有效结果的来源停止，**「补充来源数」「回退来源数」指结果条数，不是启用的供应商数量**。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-order.png" alt="排序与切换动画：将 Exa 拖到 Tavily 前面，关闭 Grok 后路由转向 Exa，再打开 Grok 恢复主搜索" width="960">
  <br><sub>把 Exa 拖到 Tavily 前，再关闭 Grok 主搜索（不是整个插件），补充来源随即接管。</sub>
</p>

## 测试搜索

「测试搜索」会逐个检查**全部已开启的来源**和 **Tavily 的每个 Key**，不会因为某个来源成功就跳过其余来源。GitHub 单独检测认证或匿名访问，不参与补充搜索。

图标点亮只表示已配置并开启，Key 是否可用以测试结果为准。右上角的图标和小圆点显示最近一次测试；空结果、认证失败、限流和网络异常会分别提示。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-test.png" alt="连通性测试动画：确认测试后依次检查 Grok、全部补充来源与 GitHub，数据沿路由流动，逐项显示结果" width="960">
  <br><sub>确认测试后逐个检查每个来源和 Key，小圆点同步更新，最后显示「5/5 项连通」。</sub>
</p>

> 测试和搜索可能消耗供应商额度。`grok-search-rs` 执行 Grok 主搜索时可能同时预取补充来源，取消操作也不保证撤回已经发出的请求。

## 静默回退

Grok 主搜索失败但补充来源返回了结果，界面显示「已静默回退」。关闭 Grok 主搜索时，则直接从你排列的补充来源开始；一家报错或返回空结果，就在剩余请求预算内尝试下一家。正常搜索拿到第一份有效结果就停止，不会为了“测完”而把四家全部调用一遍。

例如按 `Tavily → Exa → TinyFish → Firecrawl` 排序：Tavily 因额度用尽返回错误，Exa 正常返回结果，本次搜索便由 Exa 完成，无需你重新填写 Key 或手动切换。这里是故障驱动的回退，不是余额探测，也不会把耗尽的来源永久跳过。Tavily 支持多个 Key，遇到认证、限流等特定错误时还会尝试同来源的下一把 Key。

全部候选来源失败或总预算耗尽时会明确报错，**不会自动回到 DeepSeek 官方搜索**。测试与日常搜索的区别见[测试搜索](#测试搜索)。

测试时，出错的来源会短暂红边、轻颤，并在右上角显示状态码和简短原因，例如 `403 · 访问被拒绝`。日常搜索只显示实际拿到的路由信息，逐个来源和 Key 的结果以「测试搜索」为准。

<p align="center">
  <img src="https://raw.githubusercontent.com/Lain-in-coding/dsh-grok-search/main/docs/images/demo-fallback.png" alt="回退动画：Grok 认证失败后短暂红边与轻颤，路由转向 Tavily；一把 Key 失败不影响其他可用 Key，最终显示已静默回退" width="960">
  <br><sub>测试中 Grok 认证失败，路由转到 Tavily；其中一个 Key 返回 401，其余 Key 照常可用，最后显示「已静默回退」。</sub>
</p>

## 共享配置

本插件与 `grok-search-rs` 共用同一份配置文件，包含 Grok 主搜索及各补充来源的参数。页面底部的 **「Grok 共享配置」** 是这份 `grok-search-rs` 配置的入口，显示实际位置，可直接打开文件或所在文件夹；宿主无法打开时可复制路径。默认位置是用户目录下的 `.config/grok-search-rs/config.toml`，也可由 `GROK_SEARCH_CONFIG` 指定。

**保存会修改这份共享文件，使用它的其他 MCP 客户端也会受到影响。** 不另存第二份 DSH Key 配置。补充来源的顺序和开关也写入共享文件；Grok 主搜索与 GitHub 检测开关只对当前 DSH 生效，不删除共享凭据。

搜索查询会发送给实际调用的服务或自定义网关；回退过程中，同一查询可能依次发送给多家。请按自己的隐私需求选择来源。

<details>
<summary>配置冲突、Key 查看与文件入口</summary>

- 配置保存保留注释和未编辑字段。其他窗口修改了同一字段时，草稿会保留；先点击「读取最新配置」，核对后再保存。
- 保存通常在下一次搜索生效，不改变已经在途的请求。环境变量覆盖的字段只读，插件不会修改系统环境变量。
- Key 默认遮蔽，本机直连或 HTTPS 设置页面可点击眼睛查看、点击复制。无法确认安全传输的远程 HTTP 连接只显示脱敏状态，不允许查看、复制或提交明文 Key，也不能修改服务地址，以免已有 Key 被发送到新地址。
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
| `CONFIG_CONFLICT` | 读取最新配置，核对草稿后再保存 |
| `CONFIG_COMMIT_UNCERTAIN` | 先回读确认文件状态，不要反复点击覆盖 |
| `CONFIG_BUSY` / `PREFERENCES_BUSY` | 检查并发保存或上次中断；插件不会强抢遗留锁 |
| 程序准备 / 下载错误 | 检查网络或 `grok-search-rs` 程序缓存，在「Grok Search RS」中间节点查看原因并重新检测；不会覆盖全局程序 |
| `GROK_VERSION_UNVERIFIED` /「Grok 版本未经验证」 | 指 `grok-search-rs` 程序版本，不是 Grok 模型版本；未经插件验证不会自动安装、升级或覆盖，请等待插件更新 |

DSH 升级到支持范围之外时，宿主可能跳过插件，按原设置搜索。请核对版本，不要强制放行未验证组合。

</details>

## 常见问题

<details>
<summary>为什么还需要 grok-search-rs？需要再手动安装吗？</summary>

`grok-search-rs` 是由 [Episkey-G](https://github.com/Episkey-G) 开发的独立 MCP 搜索后端；本插件调用它执行 Grok 主搜索，并提供 DSH 原搜索工具接入、可视化配置、补充来源回退、诊断、进程管理和恢复。单独配置 `grok-search-rs` MCP 不会自动接管 DSH 原有的 `web_search`。

通常不用手动安装：已有兼容的 `grok-search-rs` 程序就复用，没有才下载到当前 DSH profile 的私有缓存，不改变其他 Agent 的程序路径或创建第二份 `grok-search-rs` 配置。上游程序新版未经验证时会明确提示，不盲目安装。

一个 DSH 实例串行复用一个受管的 `grok-search-rs` MCP 会话，程序空闲五分钟后退出；最多一个活动查询、八个排队查询，不会每次搜索都累积一个后台进程。

</details>

<details>
<summary>卸载会删除 Key 和配置吗？</summary>

不会。卸载保留 `grok-search-rs` 共享配置和当前 profile 下的数据：

| 位置 | 内容 |
| --- | --- |
| `grok-search/runtime-cache/` | 下载的 `grok-search-rs` 程序与校验记录 |
| `grok-search/preferences.json` | DSH 主搜索/GitHub 检测开关，不保存 Key |
| `grok-search/config-history/` | 保存前的完整配置历史，**可能包含明文 Key/Token** |
| `control-intent.records/` | 接管与恢复记录 |

请保护配置文件及历史备份。删除当前 Key 不会擦除历史中的旧 Key；备份不等于加密。不要把这些文件提交到 Git、上传公开云盘或附在问题反馈中。

本插件的本地文件冲突检查不提供网络文件系统、跨文件事务或断电恢复保证。

</details>

<details>
<summary>还有哪些验证边界？</summary>

支持范围与实测等级见上表：rc.4 Desktop 为源码审查支持，未单独实测官方桌面原包；其他组合已有对应宿主自动化记录。Linux 使用 WSL，macOS 使用托管测试环境。以下情况尚未完整覆盖：原生 Linux 的全局安装路径、macOS 和 Linux 上的真实付费接口、开发时的源码热替换、多文件写入中途崩溃，以及所有并发请求组合。DSH 官方的联网网页抓取也不在本次验证范围内。

首个公开版本仍需要更多实际环境反馈，不承诺表外兼容或零故障。遇到问题，请提供系统、DSH 版本、插件版本、`grok-search-rs` 程序版本、Grok 模型名称（如有）、简短错误码和复现步骤，**不要上传 Key、完整配置或未脱敏路径**。

</details>

## 开发与反馈

按 `package-lock.json` 准备开发依赖后：

```shell
npm run build:client
npm run test:all
npm run pack:release
```

打包不替代构建与测试。文档图片和录制脚本不随 npm 插件包分发。

[提交问题](https://github.com/Lain-in-coding/dsh-grok-search/issues) · [版本说明](https://github.com/Lain-in-coding/dsh-grok-search/releases) · [MIT 许可证](./LICENSE)

## 致谢

感谢 [Episkey-G](https://github.com/Episkey-G) 创建并维护 [grok-search-rs](https://github.com/Episkey-G/GrokSearch-rs)（[MIT 许可证](https://github.com/Episkey-G/GrokSearch-rs/blob/main/LICENSE)）。这个 Rust 编写的 MCP 搜索后端，是本插件 Grok 主搜索能力的基础；上游把搜索与来源获取能力带到 MCP 客户端，我们在其基础上专注于 DSH 原工具接入、可视化配置、多来源回退和进程管理，而不是重新开发一个搜索引擎。

如果你也想在其他 MCP 客户端使用这些能力，欢迎阅读 [grok-search-rs 的使用说明](https://github.com/Episkey-G/GrokSearch-rs#readme)，了解上游的功能与更新。两个项目独立维护。

感谢 [LINUX DO](https://linux.do/) 提供技术交流与开源分享的社区空间。
