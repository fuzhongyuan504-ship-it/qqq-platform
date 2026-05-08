# 部署指南 — GitHub Pages + Cloudflare Workers
# 预计时间：20 分钟，全程免费

## 文件结构（上传到 GitHub 仓库根目录）
qqq-platform/
├── docs/
│   └── index.html       ← 前端（GitHub Pages 从这里发布）
├── worker/
│   ├── index.js         ← Cloudflare Worker 后端
│   └── wrangler.toml    ← Worker 配置
└── DEPLOY.md

════════════════════════════════════════════════
STEP 0：⚠️  立刻撤销泄露的 API Key
════════════════════════════════════════════════
https://console.anthropic.com/settings/keys
→ 找到那个 key → Revoke → Create new key → 复制保存

════════════════════════════════════════════════
STEP 1：上传到 GitHub（3 分钟）
════════════════════════════════════════════════
1. 打开 https://github.com/new
   - 仓库名：qqq-platform
   - 选 Public（GitHub Pages 免费版需要 Public）
   - 不勾选任何初始化选项
   - 点 Create repository

2. 上传文件（两种方式选一种）：

   方式A — 网页拖拽（无需命令行）：
   - 点仓库页面的 "uploading an existing file"
   - 把解压后的 docs/ 和 worker/ 文件夹全部拖进去
   - 点 Commit changes

   方式B — 命令行：
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/你的用户名/qqq-platform.git
   git push -u origin main

════════════════════════════════════════════════
STEP 2：开启 GitHub Pages（2 分钟）
════════════════════════════════════════════════
1. 仓库 → Settings → Pages
2. Source 选 "Deploy from a branch"
3. Branch 选 main，文件夹选 /docs
4. 点 Save
5. 等约 1 分钟，页面顶部出现绿色链接：
   https://你的用户名.github.io/qqq-platform

   ✅ 前端部署完成！（此时刷新按钮还不工作，需要完成 Worker）

════════════════════════════════════════════════
STEP 3：部署 Cloudflare Worker（5 分钟）
════════════════════════════════════════════════

3-1. 安装工具（只需一次）
   npm install -g wrangler
   wrangler login   ← 打开浏览器，登录/注册 Cloudflare 账号（免费）

3-2. 创建 KV 存储（用于限流）
   cd worker/
   wrangler kv:namespace create "QQQ_KV"

   输出示例：
   { binding = "KV", id = "abc123def456789..." }

   打开 worker/wrangler.toml，把 id 填进去：
   id = "abc123def456789..."    ← 替换这一行

3-3. 注入密钥（安全！密钥只存在 Cloudflare，不进代码）
   wrangler secret put ANTHROPIC_API_KEY
   → 粘贴你在 Step 0 创建的新 API key，回车

   wrangler secret put GITHUB_PAGES_DOMAIN
   → 输入：你的用户名.github.io，回车
   （Stripe 相关的密钥等 Step 4 完成后再填）

3-4. 部署
   wrangler deploy

   成功后输出：
   https://qqq-platform.你的名字.workers.dev

════════════════════════════════════════════════
STEP 4：把 Worker 地址填入前端（1 分钟）
════════════════════════════════════════════════
打开 docs/index.html，找到第一行配置（约第 330 行）：

   const WORKER = 'https://qqq-platform.YOUR_SUBDOMAIN.workers.dev';

改成你刚才得到的 Worker 地址，保存并推送到 GitHub：

   git add docs/index.html
   git commit -m "set worker url"
   git push

GitHub Pages 约 1 分钟后自动更新。

✅ 此时网站已完全可用！点「刷新数据」会拉取实时 QQQ 数据。
   每个 IP 每天免费刷新 2 次，超出后弹出升级提示。

════════════════════════════════════════════════
STEP 5：配置 Stripe 付费（到这里喊我）
════════════════════════════════════════════════

5-1. https://stripe.com → 注册/登录
5-2. Developers → API keys → 复制 Secret key (sk_live_xxx)
     wrangler secret put STRIPE_SECRET_KEY  ← 粘贴

5-3. Products → Add product
     名称：QQQ 专业版
     价格：9.9 USD / month（Recurring）
     保存 → 复制 Price ID (price_xxx)
     wrangler secret put STRIPE_PRICE_ID  ← 粘贴

5-4. Developers → Webhooks → Add endpoint
     URL：https://qqq-platform.你的名字.workers.dev/api/stripe/webhook
     监听事件：checkout.session.completed
               customer.subscription.deleted
     保存 → 复制 Signing secret (whsec_xxx)
     wrangler secret put STRIPE_WEBHOOK_SECRET  ← 粘贴

5-5. 重新部署：wrangler deploy

════════════════════════════════════════════════
最终验证
════════════════════════════════════════════════
1. 打开 https://你的用户名.github.io/qqq-platform
2. 点「刷新数据」→ 看到实时 QQQ 数据 ✅
3. 连点 3 次 → 弹出限流提示 ✅
4. 点「升级专业版」→ 跳转 Stripe（测试卡：4242 4242 4242 4242）✅
5. 支付后跳回 → 显示升级成功 ✅

════════════════════════════════════════════════
常见问题
════════════════════════════════════════════════
Q: 点刷新报错 "Failed to fetch"
A: Worker URL 没填对，检查 docs/index.html 第一行 WORKER 变量

Q: 报错 CORS
A: Worker 已内置 CORS，确认 wrangler deploy 成功

Q: KV 命令报错
A: 确认 wrangler.toml 里的 id 已替换，且 wrangler login 已完成

Q: 查看 Worker 日志
A: wrangler tail（实时日志）
