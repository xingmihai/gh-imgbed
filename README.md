# GH-ImgBed 图床

一个免费图床：图片存进你自己的 GitHub 仓库，通过 Cloudflare 边缘节点缓存分发。

前端是 Vue 3 单页应用，部署在 Cloudflare Pages 上；上传走 Cloudflare Pages Functions 调用 GitHub Contents API；访问走自建 `/v2/` 代理。全程不需要自己的服务器。

## 特性

- **数据自主** — 图片存在你自己的仓库，数据归你所有
- **不会过期** — 没有"X 个月未访问自动删除"的策略
- **可以删除** — 上传响应里返回 `sha`，可精确删除单个文件
- **边缘缓存** — Cloudflare 全球节点缓存，首次访问即生效，无需等待第三方 CDN 预热
- **链接与后端解耦** — 访问统一走 `/v2/` 代理，日后更换存储或 CDN，已发布的老链接无需改动
- **零服务器** — 托管在 Cloudflare Pages，免费额度每天 10 万次请求
- **免域名** — 可直接使用 `*.pages.dev` 二级域名，也支持绑定自己的域名

## 技术栈

Vue 3.5 · Vite · TypeScript · Tailwind CSS · radix-vue · Cloudflare Pages Functions

## 快速开始

完整步骤见 [DEPLOY.md](./DEPLOY.md)，核心三步：

**1. 准备一个存图的 GitHub 仓库**

单独新建一个 **Public** 仓库。不要和代码仓库混用，图片会持续堆积。

**2. 创建专用令牌**

到 https://github.com/settings/personal-access-tokens/new 生成 **Fine-grained personal access token**：

- Repository access → 只选你刚建的那个存图仓库
- Permissions → **Contents: Read and write**

只给这一个仓库、只给这一项权限。即便泄露，损失也仅限于该仓库。

**3. 配置环境变量并部署**

在 Cloudflare Pages → Settings → Environment variables 添加：

| 变量名 | 说明 | 必填 |
|---|---|---|
| `GITHUB_TOKEN` | 上一步的令牌 | ✅ |
| `GITHUB_OWNER` | 存图仓库的所有者用户名 | ✅ |
| `GITHUB_REPO` | 存图仓库名 | ✅ |
| `GITHUB_BRANCH` | 分支名，默认 `main` | 可选 |
| `GITHUB_PATH` | 仓库内存放目录，留空则存根目录 | 可选 |

Production 和 Preview 两个环境都要加。改完后需要**重新部署**才会生效。

Cloudflare Pages 部署时框架预设选 `Vue`，其余保持默认。

## 工作原理

```
浏览器 ──上传──> Cloudflare Function ──> GitHub Contents API ──> 你的仓库
浏览器 ──访问──> Cloudflare Function /v2/<path>
                        │
                        ├─ 命中边缘缓存 → 直接返回
                        └─ 未命中 → GitHub Raw → 写入缓存 → 返回
```

浏览器始终只与 Cloudflare 边缘节点通信，回源由服务端完成。因此访客所在网络能否直连 GitHub 并不影响访问。

- `functions/upload.js` — 接收图片，base64 编码后写入 GitHub，文件名带日期前缀
- `functions/v2/[[vkey]].js` — 访问代理，Cloudflare Cache API 缓存，未命中回源 GitHub Raw。请求路径经白名单校验（仅图片扩展名、禁止路径穿越），避免被当作任意内容的开放代理

## 绑定自定义域名（可选）

在 Cloudflare Pages → Custom domains → Set up a domain 填入你的域名即可，CNAME 与 HTTPS 证书会自动配置。

绑定后图片链接形如：

```
https://img.5al.top/v2/261009-mcm3x.png
```

## 已知限制

| 限制 | 说明 |
|---|---|
| 单文件 20MB | 代码中已做校验 |
| 仅图片格式 | 访问代理有扩展名白名单（png/jpg/gif/webp/svg 等），其他类型一律 404 |
| GitHub API 限额 | 5000 次/小时，个人图床足够 |
| 仓库体积 | 建议控制在 1GB 以内，超了再开一个仓库 |
| 国内访问 | Cloudflare 在中国大陆无边缘节点，访客可能被路由到境外；如需国内加速，可自行接入其他 CDN 并设置 `IMG_CDN=jsdelivr` 切换回源 |

## 开发

```bash
pnpm install
pnpm dev
```

## 许可

MIT
