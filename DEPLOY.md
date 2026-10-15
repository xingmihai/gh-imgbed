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

## 六、人机验证（可选）

防止脚本批量刷上传接口。基于 Cloudflare Turnstile。

> ⚠️ **部署前必做：把 Site Key 换成你自己的**
>
> `assets/app.js` 顶部的 `TURNSTILE_SITEKEY` 是**本项目作者的**，直接部署不会生效 ——
> 该 widget 的 domains 白名单里没有你的域名，验证组件会渲染失败。
>
> ```js
> const TURNSTILE_SITEKEY = '0x4AAAAAAFUKaXfCncBNv71l'; // ← 换成你自己的
> ```
>
> 两串密钥的分工（都以 `0x4AAAAAAA` 开头，极易混淆）：
>
> | | 放哪 | 是否公开 |
> |---|---|---|
> | **Site Key** | `assets/app.js`（前端） | 公开无妨，用于**生成**挑战 |
> | **Secret Key** | 环境变量 `TURNSTILE_SECRET` | 必须保密，用于**校验**结果 |
>
> 两者必须来自**同一个 widget**，否则会报 `invalid-input-secret`。

### 为什么需要两处配置

| 配置 | 位置 | 作用 |
|---|---|---|
| widget 的 domains | Turnstile 控制台 | 哪些域名**能签发** token |
| `TURNSTILE_HOSTNAMES` | 你的环境变量 | 只接受**为你签发**的 token |

两处都要。只配控制台是不够的：任何人都能自己建一个 widget（域名填他自己的），
通过挑战后把 token 提交给你的接口，Cloudflare 会如实回答 `success=true` ——
那确实是真的 token，只是不是为你签发的。所以后端必须比对 `hostname`。

### 配置步骤

**1. 拿到密钥**

Turnstile 控制台创建 widget 后得到 **Site Key** 和 **Secret Key** 两串。

- **Site Key** 填到 `assets/app.js` 的 `TURNSTILE_SITEKEY`（公开无妨）
- **Secret Key** 填进环境变量，不要写进代码或贴进聊天

> ⚠️ **这两串长得几乎一样**（都以 `0x4AAAAAAA` 开头），光看开头分辨不出来，
> 是本项目最容易填错的地方。填错会报 `invalid-input-secret`。
> 若已混淆，直接在控制台重新生成一个 Secret Key 最省事。
>
> 两者必须来自**同一个 widget**。跨 widget 混用同样报 `invalid-input-secret`。

**2. 加环境变量**

| 变量名 | 值 |
|---|---|
| `TURNSTILE_SECRET` | widget 的 **Secret Key** |
| `TURNSTILE_HOSTNAMES` | 实际访问用的完整主机名，如 `img.5al.top` |

多个用逗号分隔，如 `img.5al.top,gh-imgbed.pages.dev`。

> ⚠️ 必须是**完整主机名**（含子域名）。`5al.top` 不等于 `img.5al.top`，
> 填错会导致所有上传返回「主机名不匹配」。
> 生产环境**不要**包含 `localhost` 或 `127.0.0.1`。

**3. 控制台也要加同一个域名**

Turnstile 控制台 → 该 widget 的 domains 里必须有 `img.5al.top`。
缺了它 token 根本签发不出来，widget 会直接报错。

**4. 重新部署**

### 验证逻辑

一次批量上传只需验证一次：

```
第 1 张 ──带 token──> 后端 siteverify ──通过──> 签发批次凭证 ──> 写入 GitHub
第 2..N 张 ──带凭证──> 后端校验 HMAC 签名 ──通过──> 写入 GitHub
```

Turnstile token 是**一次性**的，无法复用；所以由后端在首次验证通过后
签发一个 HMAC 签名的短期凭证（10 分钟），本批后续上传凭它放行。
凭证无法伪造 —— 攻击者仍须先通过一次真实验证才能拿到。

批次结束后前端重置组件，下次批量需重新验证一次。

> 未配置 `TURNSTILE_SECRET` 时行为不变（完全放行），可随时启用或停用 ——
> 万一验证出问题，删掉这个变量就能立刻恢复。

### 上传报「人机验证未通过」怎么排查

错误提示里会带上具体原因，对照这张表定位：

| 提示 | 原因 | 处理 |
|---|---|---|
| `invalid-input-secret` | Secret Key 填错，或误填成了 Site Key | 重新复制该 widget 的 Secret Key |
| 「主机名不匹配：本站接受 X，实际为 Y」 | 访问域名与 `TURNSTILE_HOSTNAMES` 不一致 | 按提示里的 `Y` 填进去 |
| `timeout-or-duplicate` | token 已被用过，或超过 300 秒 | 刷新页面重新验证 |
| `invalid-input-response` | token 无效或已过期 | 同上 |
| `missing-input-response` | 前端没把 token 传上来 | 检查 widget 是否渲染成功 |
| 「未收到验证凭据…收到的字段：file」 | 请求里完全没有验证字段 | 刷新页面；若持续出现，检查脚本是否被拦截 |
| 「验证组件未加载，请刷新页面重试」 | `challenges.cloudflare.com` 脚本没加载成功 | 检查网络能否访问该域名 |

> 实际踩过的坑，按概率排序：
> 1. **Secret Key 误填成 Site Key** —— 两者长得几乎一样，是最容易犯的错。
> 2. `TURNSTILE_HOSTNAMES` 填了根域名（`5al.top`）而实际访问是子域名（`img.5al.top`）。
> 3. 改完环境变量**没有重新部署**，函数里读到的还是旧值。
> 4. 控制台 widget 的 domains 里没加实际访问用的域名。

---

## 七、日常维护

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

**多选上传时部分失败**
前端已改为**串行上传**（`assets/app.js` 里的 `CONCURRENCY = 1`，一次只传一张），
因为同时发起多个上传会让 Cloudflare Functions 并发做多次 base64 编码，
容易超出免费额度的 CPU / 内存限制而被中断，表现为「网络错误」。
调大该值可提速，但有触发限额的风险。

**图片上传了但打不开**
确认 `images` 分支存在且文件确实写入。访问代理回源的是
`raw.githubusercontent.com/<owner>/<repo>/images/<path>`。

**刷新后上传历史没了**
历史存在浏览器 localStorage，**按域名隔离**。
换了域名后旧记录读不到，这是浏览器行为，不是故障。

**图标显示为 `cloud_upload` 这样的英文**
Material Icons 字体没加载。确认 `assets/fonts/*.woff2` 能访问，
且字体名与 mdui 期望的一致（`Material Icons` / `Material Icons Outlined`）。
