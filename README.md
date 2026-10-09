# 云枝图床 GH-ImgBed

一个免费图床：图片存进你自己的 GitHub 仓库，通过 jsDelivr 全球 CDN 分发。

前端是 Vue 3 单页应用，部署在 Cloudflare Pages 上；上传走 Cloudflare Pages Functions 调用 GitHub Contents API；访问走 jsDelivr。全程不需要自己的服务器。

## 特性

- **数据自主** — 图片存在你自己的仓库，数据归你所有
- **不会过期** — 没有"X 个月未访问自动删除"的策略
- **可以删除** — 上传响应里返回 `sha`，可精确删除单个文件
- **CDN 加速** — jsDelivr 全球节点分发，首次未命中时自动回源 GitHub Raw
- **零服务器** — 托管在 Cloudflare Pages，免费额度每天 10 万次请求
- **免域名** — 可直接使用 `*.pages.dev` 二级域名，也支持绑定自己的域名

## 技术栈

Vue 3.5 · Vite · TypeScript · Tailwind CSS · radix-vue · Cloudflare Pages Functions

## 快速开始

完整步骤见 [DEPLOY.md](./DEPLOY.md)，核心三步：

**1. 准备一个存图的 GitHub 仓库**

单独新建一个 **Public** 仓库（jsDelivr 只能加速公开仓库）。不要和代码仓库混用，图片会持续堆积。

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
| `GITHUB_PATH` | 仓库内存放目录，默认 `images` | 可选 |

Production 和 Preview 两个环境都要加。改完后需要**重新部署**才会生效。

Cloudflare Pages 部署时框架预设选 `Vue`，其余保持默认。

## 工作原理

```
浏览器 ──上传──> Cloudflare Function ──> GitHub Contents API ──> 你的仓库
                                                                    │
浏览器 ──访问──> Cloudflare Function ──> jsDelivr CDN ────────────────┘
                                        （未命中则回源 GitHub Raw）
```

- `functions/upload.js` — 接收图片，base64 编码后写入 GitHub，按 UTC 日期自动分目录
- `functions/v2/[[vkey]].js` — 访问代理，优先走 jsDelivr，404 时回源 GitHub Raw

## 已知限制

| 限制 | 说明 |
|---|---|
| 单文件 20MB | jsDelivr 的上限，代码中已做校验 |
| CDN 缓存延迟 | 新上传的图 jsDelivr 需几分钟缓存；期间自动回源，通常无感 |
| 国内访问 | jsDelivr 在国内偶发不稳定，建议绑定自己的域名以便切换 |
| GitHub API 限额 | 5000 次/小时，个人图床足够 |
| 仓库体积 | 建议控制在 1GB 以内，超了再开一个仓库 |

## 开发

```bash
pnpm install
pnpm dev
```

## 许可

MIT
