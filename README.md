# GH-ImgBed 图床

一个零服务器成本的免费图床：**图片存进你自己的 GitHub 仓库**，通过 Cloudflare 边缘节点缓存分发。

前端是纯静态页面，后端是两个 Cloudflare Pages Functions。没有数据库、没有自建服务器、没有构建步骤。

## 特性

**存储**

- **数据自主** — 图片存在你自己的 GitHub 仓库，不依赖任何第三方图床服务
- **不会过期** — 没有「X 个月未访问自动删除」的策略
- **可以删除** — 上传响应返回 `sha`，可精确删除单个文件
- **仓库可私有** — 访问代理携带令牌回源，代码无需开源

**分发**

- **边缘缓存** — Cloudflare Cache API 确定性缓存，首次访问即生效，无需等第三方 CDN 预热
- **链接与后端解耦** — 访问统一走 `/v2/` 代理，日后更换存储或 CDN，已发布的老链接一个字都不用改
- **免域名** — 可用 `*.pages.dev`，也支持绑定自己的域名

**使用**

- 点击 / 拖拽 / **粘贴**上传，支持多选
- 每条结果可：复制链接、复制 Markdown、查看二维码、打开原图、移除
- 一键复制全部链接或全部 Markdown
- 上传历史存 localStorage，刷新后仍在
- 深浅主题切换（未选择时跟随系统，首屏无闪烁）
- 小屏适配：安全区、44px 触控目标、响应式布局

## 技术栈

| 部分 | 说明 |
|---|---|
| 页面 | 原生 HTML + JavaScript，无框架、无构建 |
| 组件 | [mdui 2](https://www.mdui.org/)（Web Components，CDN 引入） |
| 图标 | Material Icons 字体（本地自托管） |
| 二维码 | qrcode（CDN，按需动态加载） |
| 后端 | Cloudflare Pages Functions |

## 快速开始

完整步骤见 [DEPLOY.md](./DEPLOY.md)，这里是精简版。

### 1. 准备存图位置

图片写入仓库的 **`images` 分支**。建议该分支为**孤儿分支**（无父提交），与代码历史完全隔离：

```bash
git switch --orphan images
git rm -rf .
echo "# 图库" > README.md
git add README.md
git commit -m "init: 图片存储分支"
git push -u origin images
```

可以是独立仓库，也可以是代码仓库的一个分支 —— 后者只需一个仓库一个令牌。

> **分支名固定为 `images`，不能自定义**：访问代理不校验路径，
> 若图片与代码同分支，代码文件可能被构造路径读到。固定分支是安全隔离的前提。

### 2. 创建专用令牌

到 https://github.com/settings/personal-access-tokens/new 生成 **Fine-grained personal access token**：

- Repository access → 只选存图用的那个仓库
- Permissions → **Contents: Read and write**

只给这一个仓库、只给这一项权限。即便泄露，损失也仅限于该仓库。

### 3. 配置环境变量并部署

Cloudflare Pages → Settings → Environment variables：

| 变量名 | 说明 | 必填 |
|---|---|---|
| `GITHUB_TOKEN` | 上一步的令牌 | ✅ |
| `GITHUB_OWNER` | 存图仓库的所有者用户名 | ✅ |
| `GITHUB_REPO` | 存图仓库名 | ✅ |
| `GITHUB_PATH` | 仓库内子目录，留空则存根目录（链接更短） | 可选 |

Production 和 Preview 两个环境都要加。改完需**重新部署**才生效。

Pages 构建设置：

| 配置项 | 值 |
|---|---|
| Framework preset | **None** |
| Build command | 留空 |
| Build output directory | `/` |

> ⚠️ 另外务必把 **Branch Preview 设为 None**（或只勾 `main`），
> 否则每次上传图片推送到 `images` 分支都会触发构建，很快耗尽每月 500 次的免费额度。

## 工作原理

```
上传：浏览器 ──> /upload ──> GitHub Contents API ──> images 分支
访问：浏览器 ──> /v2/<path> ──┬─ 命中边缘缓存 → 直接返回
                              └─ 未命中 → GitHub Raw → 写缓存 → 返回
```

浏览器始终只与 Cloudflare 边缘节点通信，回源由服务端完成。
因此**访客所在网络能否直连 GitHub 并不影响访问**。

- `functions/upload.js` — 接收图片，base64 后写入 GitHub；文件名格式为 `YYMMDD-5位随机.扩展名`
- `functions/v2/[[vkey]].js` — 访问代理，Cache API 缓存，未命中回源 GitHub Raw

## 绑定自定义域名（可选）

Cloudflare Pages → Custom domains → Set up a domain，填入域名即可，CNAME 与 HTTPS 证书自动配置。

链接由服务端按请求域名自动拼接，绑完无需改任何代码，重新部署一次即可：

```
https://img.example.com/v2/261010-k7f2m.png
```

## 已知限制

| 限制 | 说明 |
|---|---|
| 单文件 20MB | 代码中已做校验 |
| 访问路径未做白名单 | 依赖 `images` 孤儿分支做隔离；不要往该分支放非图片文件 |
| GitHub API 限额 | 5000 次/小时，个人图床足够 |
| Cloudflare 免费额度 | 请求 10 万/天，构建 500 次/月 |
| 仓库体积 | 建议控制在 1GB 以内 |
| 国内访问 | Cloudflare 在中国大陆无边缘节点，访客可能被路由到境外。可设 `IMG_CDN=jsdelivr` 改走 jsDelivr 回源 |

## 部署前自检

```bash
export GITHUB_TOKEN='github_pat_xxx'
export GITHUB_OWNER='你的用户名'
export GITHUB_REPO='你的仓库'
python3 scripts/verify_upload.py
```

脚本会依次检查令牌有效性、仓库可访问性、写入权限、链接可访问性，并自动清理测试文件。

## 本地开发

无需安装依赖：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 上传接口由 Cloudflare Pages Functions 提供，本地静态服务器无法调用，
> 界面可预览，完整测试需部署后。

## 目录结构

```
index.html                  页面结构
assets/app.css              样式：设计令牌、深浅主题、响应式
assets/app.js               逻辑：上传、列表、复制、二维码、主题
assets/fonts.css            Material Icons 字体声明（本地）
assets/fonts/*.woff2        Material Icons 字体文件（filled / outlined）
functions/upload.js         上传：写入 GitHub
functions/v2/[[vkey]].js   访问：回源 + 边缘缓存
scripts/verify_upload.py    部署前自检脚本
```

> **图标说明**：mdui 的 CSS 不含图标字体。本项目将 Material Icons 字体下载到
> `assets/fonts/` 并本地声明，**不引用 fonts.googleapis.com**（该域名在中国大陆不可访问）。
> 字体名须与 mdui 期望的完全一致（`Material Icons` / `Material Icons Outlined`），
> 且需开启 `font-feature-settings: 'liga'`（mdui 自身不设置），否则连字不生效、图标会显示为文字。

## 许可

[MIT](./LICENSE)

本项目基于 [ZYCS-IMG](https://github.com/vvhan/ZYCS-IMG)（Copyright 2020 Han）二次开发，
依 MIT 协议保留原作者版权声明，同时追加本项目作者的版权。
