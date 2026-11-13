# 部署到 EdgeOne Pages 国际版

本文档适用于 **`edgeone` 分支**。Cloudflare 版见 [DEPLOY.md](./DEPLOY.md)。

`main` 分支未做任何改动，两个分支可各自独立部署。

---

## 与 Cloudflare 版的差异

| 项目 | Cloudflare 版（main） | EdgeOne 版（edgeone） |
|---|---|---|
| 函数目录 | `functions/` | **`edge-functions/`** |
| 上传函数 | `functions/upload.js` | `edge-functions/upload.js` |
| 访问函数 | `functions/v2/[[vkey]].js` | **`edge-functions/v2/[[default]].js`** |
| 单文件上限 | 前端 15MB / 后端 20MB | **前端 0.9MB / 后端 0.9MB** |
| `waitUntil` | `request.ctx.waitUntil()` | **`context.waitUntil()`** |
| 客户端 IP | `CF-Connecting-IP` | `EO-Client-IP` / `X-Forwarded-For` |
| 缓存过期 | 静默失效 | **抛 504，代码已捕获并删键回源** |
| 回源缓存 | `immutable` | 改用 `s-maxage`（EdgeOne 识别值） |

核心逻辑（GitHub 写入、Turnstile 校验、批次凭证）两边完全一致。
EdgeOne 的 Edge Functions 基于 V8 + 标准 Web API，`caches.default`、
`crypto.subtle`、`fetch`、`Response` 写法都和 Cloudflare Workers 一样。

---

## ⚠️ 最重要的一条：1MB 请求体限制

EdgeOne **Edge Functions 的请求 body 上限是 1MB**（免费版硬限制），
而 Cloudflare 版可以传 20MB。这是平台限制，改代码绕不过去。

因此本分支：

- 前端 `MAX_SIZE_MB = 0.9`（超过直接过滤，不发请求）
- 后端 `MAX_BYTES = 0.9MB`（multipart 边界、验证 token 也要占请求体）

**适合传截图、压缩过的图片；手机直出照片（3~5MB）传不了。**

> 1MB 只限制「浏览器 → EdgeOne」的入站请求。
> 函数出站 PUT 到 `api.github.com`（携带 base64）不受此限制。

### 想要更大上限怎么办

把上传迁到 **Cloud Functions**（Node.js 运行时，请求 body 上限 **6MB**），
访问代理继续留在 Edge Functions 保住边缘缓存。代价是上传上限从 20MB 降到 6MB，
且需把 `upload.js` 放到 `cloud-functions/upload.js` 并验证 `request.formData()`
在 Node 运行时的可用性。详见文末「升级到 6MB」。

---

## 一、准备 `images` 分支

图片写入仓库的 **`images` 分支**（代码里硬编码，不可自定义）。建议建为孤儿分支：

```bash
git switch --orphan images && git rm -rf .
echo "# 图库" > README.md
git add README.md && git commit -m "init: 图片存储分支"
git push -u origin images
```

> 访问代理不校验路径，若图片与代码同分支，代码文件可能被构造路径读到。
> 所以**不要往 `images` 分支放非图片文件**。
>
> 分支不存在时 GitHub **不会自动创建**，上传会返回 `Branch images not found`。

---

## 二、创建令牌

[Fine-grained token](https://github.com/settings/personal-access-tokens/new)：

| 配置项 | 填写 |
|---|---|
| Repository access | **Only select repositories** → 只勾存图仓库 |
| Permissions | **Contents: Read and write** |

只给这一个仓库、这一项权限。

> 免费版环境变量值长度上限 500 字节，令牌远小于此，无碍。

---

## 三、导入仓库并配置构建

EdgeOne Pages 国际版（edgeone.ai）→ 创建项目 → 导入 GitHub 仓库 →
**分支选 `edgeone`**（不要选 main，也不要选 images）。

| 配置项 | 值 |
|---|---|
| Framework preset | **None / Other**（纯静态，无构建） |
| Build command | 留空 |
| Output directory | `/` |

`edge-functions/` 会被自动识别并生成路由：

```
edge-functions/upload.js            →  /upload
edge-functions/v2/[[default]].js    →  /v2/<任意多级路径>
```

> **静态资源路由优先**：`/upload` 和 `/v2/` 下没有静态文件，才会落到函数。
> 若你在这两个路径下放了文件，函数会被遮蔽。

> ⚠️ 每次往 `images` 分支推图都会触发构建。免费版 **500 次/月**，
> 建议在项目设置里限制触发构建的分支，或只监听 `index.html`、`assets/**`、
> `edge-functions/**`。

---

## 四、配置环境变量

项目设置 → 环境变量（Production / Preview 各自配置）：

| 变量 | 值 |
|---|---|
| `GITHUB_TOKEN` | 上一步的令牌 |
| `GITHUB_OWNER` | 存图仓库所有者（用户名或组织名） |
| `GITHUB_REPO` | 存图仓库名 |
| `GITHUB_PATH` | 可选，留空存根目录（链接更短） |
| `TURNSTILE_SECRET` | 可选，Turnstile 的 **Secret Key** |
| `TURNSTILE_HOSTNAMES` | 启用验证时必填，完整主机名 |

改完需**重新部署**才生效。EdgeOne 的环境变量不会从 Cloudflare 同步过来。

---

## 五、绑定自定义域名（可选）

项目 → 域名管理 → 添加域名，按提示加 CNAME，证书自动签发。

链接由服务端按请求域名自动拼接，**绑完无需改代码**，重新部署即可。

> ⚠️ **域名换了，Turnstile 两处都要跟着改**：
> 1. Turnstile 控制台 → 该 widget 的 **domains** 加上新域名
> 2. `TURNSTILE_HOSTNAMES` 填**完整主机名**（如 `img.eo.5al.top`，
>    不能只写 `5al.top`），且必须与控制台一致

---

## 六、人机验证（可选）

与 Cloudflare 版完全一致，Turnstile 是纯 HTTP 调用，不依赖部署平台。

**部署前必做**：把 `assets/app.js` 顶部的 `TURNSTILE_SITEKEY` 换成你自己的。
仓库里那个是本项目的，它的 domains 白名单不含你的域名。

```js
const TURNSTILE_SITEKEY = '0x4AAAAAAFUKaXfCncBNv71l'; // ← 换成你自己的
```

> Site Key 与 Secret Key **都以 `0x4AAAAAAA` 开头，极易混淆**，且必须来自同一
> widget。Site Key 进前端（公开无妨），Secret Key 只进环境变量。
> 混用会报 `invalid-input-secret`。

**验证逻辑**：token 一次性，所以「一次验证放行整批」由后端签发 HMAC 凭证实现：

```
第 1 张  ──带 token──> siteverify 通过 ──> 签发 HMAC 凭证（10 分钟）
第 2..N 张 ──带凭证──> 校验签名与有效期 ──> 写入 GitHub
```

> 未配 `TURNSTILE_SECRET` 时完全放行。本分支前端**始终显示验证框**
> （探测功能在 Cloudflare 版才有），若想停用，删掉 `index.html` 里
> `#turnstileBox` 那段和 `challenges.cloudflare.com` 脚本即可。
>
> 注意：`challenges.cloudflare.com` 在部分 EdgeOne 国际节点可能连通性不佳，
> 启用前建议先在本机实测 widget 能否渲染。

---

## 七、验证

```bash
export GITHUB_TOKEN='github_pat_xxx' GITHUB_OWNER='用户名' GITHUB_REPO='仓库名'
python3 scripts/verify_upload.py
```

然后打开站点：

1. 上传一张 **<0.9MB** 的图 → 出现进度圈 → 完成后显示缩略图
2. 点开链接 → 图片正常显示
3. 刷新页面 → 历史仍在
4. 多选 3 张 → 一次验证，依次上传成功

---

## 八、排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/upload` 返回 404 | 函数目录不对，或部署选了 main 分支 | 确认部署分支是 `edgeone`、目录是 `edge-functions/` |
| `/v2/xxx.png` 返回 404 | 访问函数没生效 | 确认文件名是 `[[default]].js` |
| 上传 413「超过 0.9MB」 | EdgeOne 1MB 硬限制 | 压缩图片，或走「升级到 6MB」 |
| 「请求体解析失败（运行时不支持 formData）」 | 该运行时未实现 `Request.formData()` | 迁到 Cloud Functions |
| 「服务端未配置 GITHUB_TOKEN…」 | 环境变量没加或没重新部署 | 检查 Production / Preview 两份 |
| `Branch images not found` | `images` 分支不存在 | 见第一节 |
| `invalid-input-secret` | Secret 填错或误填成 Site Key | 重新复制 Secret Key |
| 「主机名不匹配：…实际为 X」 | 换域名后没改 `TURNSTILE_HOSTNAMES` | 按提示里的 `X` 填进去 |
| widget 渲染失败 | 控制台 domains 没加新域名，或脚本被拦 | 检查控制台与网络 |
| 图片偶发 504 | 边缘缓存过期（EdgeOne 特性） | 代码已自动删键回源；持续出现就清缓存 |

---

## 九、免费版配额（EdgeOne Pages 国际版）

| 项目 | 额度 |
|---|---|
| 构建 | 500 次/月 |
| Edge Functions 执行 | 300 万次/月 |
| Edge Functions CPU 时间 | 300 万 ms/月（单次 200ms） |
| Edge Functions 请求 body | **1 MB** |
| Cloud Functions 请求 body | 6 MB |
| 自定义域名 | 200 个，免费 SSL |
| 单项目存储 | 5 GB / 20000 文件 |

> 单次 CPU 200ms 不含 I/O 等待。0.9MB 的 base64 编码是纯 CPU 操作，
> 若发现大图上传卡住，可适当把 `MAX_BYTES` 再调小一点。

---

## 升级到 6MB（可选）

1. 新建 `cloud-functions/upload.js`，内容复制 `edge-functions/upload.js`
2. 删掉 `edge-functions/upload.js`（避免路由冲突）
3. 把 `MAX_BYTES` 改为 `5.5 * 1024 * 1024`（给 multipart 留余量），
   前端 `MAX_SIZE_MB` 同步改
4. 验证 Node.js 运行时的 `request.formData()` 与 `crypto.subtle` 可用
   （Node 20 有全局 `crypto`，一般没问题）
5. 重新部署

访问代理**继续留在 `edge-functions/`**，边缘缓存不受影响。

---

## 日常维护

删图、清缓存、换令牌等操作与 Cloudflare 版相同，见 [DEPLOY.md](./DEPLOY.md) 第七节。
清缓存在 EdgeOne 控制台：站点列表 → 清除缓存。

**建议给 `images` 分支加删除保护**
GitHub → Settings → Branches → Add branch ruleset → 分支填 `images` →
勾 **Restrict deletions**。图片全在这一个孤儿分支上，误删一次所有已发布链接全部失效。
