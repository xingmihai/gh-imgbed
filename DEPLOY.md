# 部署说明

全程不需要自己的服务器。整个图床由三部分组成：

| 部分 | 说明 |
|---|---|
| 静态页面 | `index.html` + `assets/`，无需构建 |
| 上传函数 | `functions/upload.js`，写入 GitHub 仓库的 `images` 分支 |
| 访问函数 | `functions/v2/[[vkey]].js`，回源 GitHub Raw + 边缘缓存 |

预计耗时 15 分钟。

---

## 一、准备 `images` 分支

图片写入仓库的 **`images` 分支**。分支名在代码中是硬编码常量，**不可自定义**。

该分支应为**孤儿分支**（没有父提交），这样图片历史和代码历史完全独立、互不干扰：

```bash
git switch --orphan images
git rm -rf .
echo "# 图库" > README.md
git add README.md
git commit -m "init: 图片存储分支"
git push -u origin images
```

完成后记下 `所有者用户名` 和 `仓库名`。

> **为什么必须是独立分支**
>
> 访问代理 `/v2/` 不校验请求路径。若图片与代码同处一个分支，
> 理论上可以构造路径让代理读到代码文件。孤儿分支里只有图片，
> 代码不在访问范围内，天然隔离。
>
> 因此：**不要往 `images` 分支放任何非图片文件，也不要把图片传到代码分支。**

### 仓库可以是私有的

访问函数在配置了 `GITHUB_TOKEN` 时会携带认证头回源，
所以**存图仓库不必设为 public**，代码可以保持私有。

> 图片经代理后对外仍是可访问的（这本来就是图床的目的），但代码分支读不到。

---

## 二、创建专用令牌

到 https://github.com/settings/personal-access-tokens/new 生成 **Fine-grained personal access token**：

| 配置项 | 填写 |
|---|---|
| Token name | 随意，如 `gh-imgbed-upload` |
| Expiration | 建议 90 天或 1 年 |
| Repository access | **Only select repositories** → 只勾存图用的那个仓库 |
| Permissions | Repository permissions → **Contents: Read and write** |

生成后复制那串 `github_pat_...`，**只填进 Cloudflare 环境变量，不要写进任何代码文件**。

> ⚠️ 只给这一个仓库、只给 Contents 读写这一项权限。即便泄露，损失也仅限于该仓库。

---

## 三、部署到 Cloudflare Pages

### 3.1 构建设置

前端是纯静态页面，**不需要构建**：

| 配置项 | 值 |
|---|---|
| Framework preset | **None**（不要选 Vue） |
| Build command | 留空 |
| Build output directory | `/`（项目根目录） |

### 3.2 环境变量

Pages 项目 → **Settings** → **Environment variables** → Add：

| 变量名 | 值 | 必填 |
|---|---|---|
| `GITHUB_TOKEN` | 上一步的令牌 | ✅ |
| `GITHUB_OWNER` | 存图仓库的所有者用户名 | ✅ |
| `GITHUB_REPO` | 存图仓库名 | ✅ |
| `GITHUB_PATH` | 仓库内子目录，留空则存根目录（链接更短） | 可选 |

> Production 和 Preview 两个环境都要加，否则预览部署上传会报错。
> 改完环境变量后需要 **重新部署** 才会生效。

### 3.3 ⚠️ 关闭分支预览构建（必做）

Cloudflare Pages → **Settings** → **Builds & deployments**：

- **Branch Preview** 设为 `None`，或只勾选 `main`

否则**每次上传图片推送到 `images` 分支都会触发一次构建**。
Pages 免费额度是**每月 500 次构建**，传几十张图就可能耗尽。

> 替代方案：在 **Build watch paths** 中只填代码路径
> （`index.html`、`assets/**`、`functions/**`），忽略图片分支的变更。

---

## 四、验证

部署完成后，先跑一次链路自检：

```bash
export GITHUB_TOKEN='github_pat_xxx'
export GITHUB_OWNER='你的用户名'
export GITHUB_REPO='你的仓库名'
python3 scripts/verify_upload.py
```

脚本会依次检查：令牌有效性 → 仓库可访问性 → 写入权限 → 链接可访问性，
并在结束时自动清理测试文件。

> 脚本默认写入 `images` 分支（与线上一致）。若提示 403，通常是令牌缺 `Contents` 写权限。

然后打开站点，上传一张图确认：

- 上传中显示环形进度，完成后显示缩略图
- 链接可点开
- 刷新页面后历史仍在

---

## 五、绑定自定义域名（可选）

1. Cloudflare Pages → **Custom domains** → Set up a domain
2. 填入域名（如 `img.example.com`）
3. 若 DNS 已托管在 Cloudflare，CNAME 与证书会自动配置；否则需到 DNS 商处手动加一条 CNAME 指向 `项目名.pages.dev`

链接由服务端按请求域名自动拼接，**绑完无需改任何代码**，重新部署一次即可：

```
https://img.example.com/v2/261010-k7f2m.png
```

---

## 六、日常维护

### 删除单张图片

每次上传的响应里带有 `sha`，浏览器已存在 localStorage。用它可精确删除：

```bash
curl -X DELETE \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/contents/<path> \
  -d '{"message":"delete","sha":"<上传时返回的 sha>","branch":"images"}'
```

也可以在 GitHub 网页上直接删除文件。

> 注意：边缘缓存最长保留 1 年。删除后如需立即生效，
> 到 Cloudflare 后台手动清除缓存（Caching → Configuration → Purge Everything）。

### 更换令牌

令牌到期后重新生成一个，更新 Pages 的 `GITHUB_TOKEN` 环境变量并**重新部署**。

### 仓库满了

GitHub 建议单仓库控制在 1GB 以内。超了就：

1. 新建仓库，建 `images` 孤儿分支
2. 改 `GITHUB_REPO` 环境变量
3. 重新部署

旧仓库的链接会失效，如需保留可保留旧仓库不动、只切换新图。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 单文件 20MB | 代码中已做校验 |
| 访问路径未做白名单 | 依赖 `images` 孤儿分支隔离；不要往该分支放非图片文件 |
| GitHub API 限额 | 5000 次/小时，个人图床足够 |
| Cloudflare 免费额度 | 请求 10 万/天，构建 500 次/月 |
| 仓库体积 | 建议 1GB 以内 |
| 国内访问 | Cloudflare 在中国大陆无边缘节点，访客可能被路由到境外。可设 `IMG_CDN=jsdelivr` 改走 jsDelivr 回源 |

---

## 常见问题

**上传返回 403**
令牌缺 `Contents: Read and write`，或 Repository access 没包含该仓库。

**上传返回 422**
通常是同名文件冲突，代码会自动换名重试 6 次；若仍失败，检查分支是否存在。

**图片上传了但打不开**
确认 `images` 分支存在且文件确实写入。访问代理回源的是
`raw.githubusercontent.com/<owner>/<repo>/images/<path>`。

**刷新后上传历史没了**
历史存在浏览器 localStorage，**按域名隔离**。
换了域名后旧记录读不到，这是浏览器行为，不是故障。

**图标显示为 `cloud_upload` 这样的英文**
Material Icons 字体没加载。确认 `assets/fonts/*.woff2` 能访问，
且字体名与 mdui 期望的一致（`Material Icons` / `Material Icons Outlined`）。
