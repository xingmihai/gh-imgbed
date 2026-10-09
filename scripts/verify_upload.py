#!/usr/bin/env python3
"""
GH图床 —— 上传链路验证脚本

在部署到 Cloudflare 之前，先确认三件事：
  1. 令牌有权限写你的存图仓库
  2. 文件能按预期路径写入
  3. jsDelivr 能取到刚上传的图

用法：
    export GITHUB_TOKEN='github_pat_xxx'
    export GITHUB_OWNER='你的用户名'
    export GITHUB_REPO='你的仓库名'
    python3 scripts/verify_upload.py

可选环境变量：
    GITHUB_PATH    仓库内子目录，留空则存根目录
"""

import base64
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOKEN = os.environ.get("GITHUB_TOKEN", "")
OWNER = os.environ.get("GITHUB_OWNER", "")
REPO = os.environ.get("GITHUB_REPO", "")
BRANCH = "images"  # 与 upload.js 中的 IMG_BRANCH_NAME 保持一致
SUBPATH = os.environ.get("GITHUB_PATH", "")

API = "https://api.github.com"

# 1x1 测试 PNG
TEST_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

ok = True


def say(flag, msg):
    global ok
    if flag is False:
        ok = False
    print(("  [OK]   " if flag else "  [FAIL] ") + msg if flag is not None else "         " + msg)


def api(path, data=None, method="GET"):
    url = API + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "gh-imgbed-verify",
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        raw = resp.read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return {"__err": e.code, "__msg": e.read()[:200].decode(errors="replace")}
    except Exception as e:
        return {"__err": 0, "__msg": repr(e)}


def head(url):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "gh-imgbed-verify"})
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


print("=== GH图床 上传链路验证 ===\n")

# 0. 检查配置
say(None, f"OWNER = {OWNER or '(未设置)'}")
say(None, f"REPO  = {REPO}")
say(None, f"BRANCH= {BRANCH}（固定值，不可配置）")
say(None, f"PATH  = {SUBPATH}\n")
if not TOKEN or not OWNER or not REPO:
    say(False, "缺少 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO，请先设置环境变量")
    sys.exit(1)

# 1. 令牌与仓库连通性
print("[1/4] 检查令牌与仓库")
me = api("/user")
if "__err" in me:
    say(False, f"令牌无效或网络不通：{me['__msg']}")
    sys.exit(1)
say(True, f"令牌有效，身份：{me.get('login')}")

repo = api(f"/repos/{OWNER}/{REPO}")
if "__err" in repo:
    say(False, f"读取仓库失败（{repo['__err']}）：{repo['__msg']}")
    sys.exit(1)
say(True, f"仓库可访问：{repo['full_name']}")
if repo.get("private"):
    say(False, "仓库是 Private！jsDelivr 只能加速公开仓库，请改为 Public")
else:
    say(True, "仓库是 Public，jsDelivr 可以加速")

# 2. 写入测试文件
print("\n[2/4] 写入测试图片")
now = datetime.datetime.utcnow()
# 与 upload.js 保持一致：扁平文件名，日期前缀 + 随机
yymmdd = f"{str(now.year)[2:]}{now.month:02d}{now.day:02d}"
name = f"{yymmdd}-verify{int(time.time()) % 100000:05d}.png"
path = f"{SUBPATH}/{name}" if SUBPATH else name
res = api(
    f"/repos/{OWNER}/{REPO}/contents/{path}",
    {"message": "verify: upload test", "content": base64.b64encode(TEST_PNG).decode(), "branch": BRANCH},
    "PUT",
)
if "__err" in res or "content" not in res:
    say(False, f"写入失败（{res.get('__err')}）：{res.get('__msg')}")
    say(None, "  确认令牌勾选了该仓库的 Contents: Read and write")
    sys.exit(1)
say(True, f"写入成功：{path}")
sha = res["content"]["sha"]

# 3. 直链
print("\n[3/4] 生成访问链接")
cdn = f"https://cdn.jsdelivr.net/gh/{OWNER}/{REPO}@{BRANCH}/{path}"
raw = f"https://raw.githubusercontent.com/{OWNER}/{REPO}/{BRANCH}/{path}"
say(None, "jsDelivr : " + cdn)
say(None, "GitHubRaw: " + raw)

print("\n[4/4] 检查可访问性（jsDelivr 首次缓存需几分钟，404 属正常）")
time.sleep(2)
s_raw = head(raw)
say(s_raw == 200, f"GitHub Raw 返回 {s_raw}")
s_cdn = head(cdn)
if s_cdn == 200:
    say(True, f"jsDelivr 返回 {s_cdn} —— 已缓存")
elif s_cdn == 404:
    say(None, f"jsDelivr 返回 404 —— 尚未缓存，等几分钟再试即可（代码里已做回源兜底）")
else:
    say(None, f"jsDelivr 返回 {s_cdn} —— 可能是当前网络无法访问，请以实际部署环境为准")

# 5. 清理测试文件
print("\n[5/5] 清理测试文件")
delres = api(
    f"/repos/{OWNER}/{REPO}/contents/{path}",
    {"message": "verify: cleanup", "sha": sha, "branch": BRANCH},
    "DELETE",
)
if "__err" in delres:
    say(None, f"自动清理失败（{delres.get('__err')}），请手动删除 {path}")
else:
    say(True, "已清理")

print("\n=== 结果 ===")
if ok:
    print("上传链路正常，可以去 Cloudflare Pages 配置环境变量并部署了。")
else:
    print("存在未通过项，请按上面的提示修复后再部署。")
