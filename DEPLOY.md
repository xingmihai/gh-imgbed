# 部署说明（GitHub 存储 + jsDelivr CDN）

图片存进你自己的 GitHub 仓库，通过 jsDelivr CDN 分发。

- 上传走 GitHub Contents API，访问走 jsDelivr（未命中缓存时回源 GitHub Raw）
- 服务端跑在 Cloudflare Pages Functions 上，无需自己的服务器

---

## 一、准备一个存图的 GitHub 仓库

**建议单独新建一个仓库**（例如 `ZYCS-IMG-CDN`），不要和本项目的代码仓库混用：图片会不断堆积，混在一起会让代码仓库变得臃肿。

1. 新建仓库，设为 Public（jsDelivr 只能加速公开仓库）
2. 记下 `所有者用户名` 和 `仓库名`

---

## 二、创建专用令牌（很重要）

去 https://github.com/settings/personal-access-tokens/new 创建一个 **Fine-grained personal access token**：

| 配置项 | 填写 |
|---|---|
| Token name | 随意，如 `zycs-img-upload` |
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
| `GITHUB_PATH` | 仓库内存放目录，默认 `images` | 可选 |

> Production 和 Preview 两个环境都要加，否则预览分支上传会报错。
> 改完环境变量后需要 **重新部署** 才会生效。

---

## 四、部署

跟原来一样，框架预设选 `Vue`，其余保持默认。提交代码即自动构建。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 单文件 20MB | jsDelivr 的上限，已写入代码校验 |
| CDN 缓存延迟 | 新上传的图 jsDelivr 需几分钟才缓存到；期间会自动回源 GitHub Raw，因此通常无感 |
| 国内访问 | jsDelivr 在国内偶发不稳定。**强烈建议绑一个自己的域名做 CNAME**，出问题可快速切换 |
| GitHub API 限额 | 5000 次/小时，个人图床足够 |
| 仓库体积 | 建议控制在 1GB 以内；超了就再开一个仓库，改环境变量切换 |

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

也可以在 GitHub 网页上直接删文件，jsDelivr 缓存会随之失效。
