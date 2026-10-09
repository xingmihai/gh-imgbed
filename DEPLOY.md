# 部署说明（GitHub 存储 + Cloudflare 边缘缓存）

图片存进你自己的 GitHub 仓库，通过 Cloudflare 边缘节点缓存分发。

- 上传走 GitHub Contents API，访问走自建 `/v2/` 代理（Cloudflare Cache API 缓存）
- 服务端跑在 Cloudflare Pages Functions 上，无需自己的服务器

---

## 一、准备一个存图的 GitHub 仓库

**建议单独新建一个仓库**（例如 `imgs`），不要和本项目的代码仓库混用：图片会不断堆积，混在一起会让代码仓库变得臃肿。

1. 新建仓库，设为 Public
2. 记下 `所有者用户名` 和 `仓库名`

---

## 二、创建专用令牌（很重要）

去 https://github.com/settings/personal-access-tokens/new 创建一个 **Fine-grained personal access token**：

| 配置项 | 填写 |
|---|---|
| Token name | 随意，如 `gh-imgbed-upload` |
| Expiration | 建议 90 天或 1 年 |
| Repository access | **Only select repositories** → 只勾你刚建的那个存图仓库 |
| Permissions | Repository permissions → **Contents: Read and write** |

生成后复制那串 `github_pat_...`，**只填进 Cloudflare 环境变量，不要写进任何代码文件**。

> ⚠️ 权限只给这一个仓库、只给 Contents 读写。即便泄露，损失也仅限于该仓库。

---

## 三、在 Cloudflare Pages 配置环境变量

进入你的 Pages 项目 → **Settings** → **Environment variables** → Add：

| 变量名 | 值 | 必填 |
|---|---|---|
| `GITHUB_TOKEN` | 上一步的令牌 | ✅ |
| `GITHUB_OWNER` | 存图仓库的所有者用户名 | ✅ |
| `GITHUB_REPO` | 存图仓库名 | ✅ |
| `GITHUB_BRANCH` | 分支名，默认 `main` | 可选 |
| `GITHUB_PATH` | 仓库内存放目录，留空则存根目录 | 可选 |

> Production 和 Preview 两个环境都要加，否则预览分支上传会报错。
> 改完环境变量后需要 **重新部署** 才会生效。

---

## 四、部署

前端是纯静态页面，**不需要构建**。在 Cloudflare Pages 中：

| 配置项 | 值 |
|---|---|
| Framework preset | **None**（不要选 Vue） |
| Build command | 留空 |
| Build output directory | `/`（项目根目录） |

提交代码即自动部署。

部署完成后，可先跑一次上传链路验证：

```bash
export GITHUB_TOKEN='github_pat_xxx'
export GITHUB_OWNER='你的用户名'
export GITHUB_REPO='imgs'
python3 scripts/verify_upload.py
```

---

## 五、绑定自定义域名（可选，推荐）

1. Cloudflare Pages → **Custom domains** → Set up a domain
2. 填入域名（如 `img.5al.top`）
3. 若 DNS 已托管在 Cloudflare，CNAME 与证书会自动配置；否则需到你的 DNS 商处手动加一条 CNAME 指向 `项目名.pages.dev`

绑定后链接形如：

```
https://img.5al.top/v2/261009-mcm3x.png
```

链接由服务端按请求域名自动拼接，无需额外配置环境变量。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 单文件 20MB | 代码中已做校验 |
| GitHub API 限额 | 5000 次/小时，个人图床足够 |
| 仓库体积 | 建议控制在 1GB 以内；超了就再开一个仓库，改环境变量切换 |
| 国内访问 | Cloudflare 在中国大陆无边缘节点，访客可能被路由到境外。如需切换回源，设置 `IMG_CDN=jsdelivr` 即可改走 jsDelivr |

---

## 关于删除图片

每次上传的响应里带有 `sha`，Cloudflare 返回给前端后存在浏览器 localStorage。
用它可以删除图片：

```bash
curl -X DELETE \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/contents/<path> \
  -d '{"message":"delete","sha":"<上传时返回的 sha>","branch":"main"}'
```

也可以在 GitHub 网页上直接删文件。注意边缘缓存最长保留 1 年，删除后如需立即生效，可在 Cloudflare 后台手动清除缓存。
