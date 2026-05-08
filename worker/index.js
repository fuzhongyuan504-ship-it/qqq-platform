const FREE_LIMIT  = 2;
const PAID_LIMIT  = 50;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const { pathname } = new URL(request.url);
    if (pathname === '/api/check-limit')      return handleCheckLimit(request, env);
    if (pathname === '/api/market')           return handleMarket(request, env);
    if (pathname === '/api/stripe/checkout')  return handleCheckout(request, env);
    if (pathname === '/api/stripe/webhook')   return handleWebhook(request, env);
    if (pathname === '/api/stripe/verify')    return handleVerify(request, env);
    return json({ error: 'Not found' }, 404);
  }
};

async function handleCheckLimit(request, env) {
  const ip = getIP(request);
  const { used, limit, isPaid } = await getUsage(ip, env);
  return json({ used, limit, remaining: limit - used, isPaid });
}

async function handleMarket(request, env) {
  const ip = getIP(request);
  const body = await request.json().catch(() => ({}));
  const period = body.period || '1M';
  const { used, limit, isPaid } = await getUsage(ip, env);
  if (used >= limit) {
    return json({ error: 'RATE_LIMIT', message: `今日${isPaid?'专业版':'免费'}额度（${limit}次）已用完`, used, limit, isPaid }, 429);
  }
  await incrementUsage(ip, env);
  try {
    const data = await fetchQQQData(period, env);
    return json({ success: true, data, used: used + 1, limit });
  } catch (e) {
    await decrementUsage(ip, env);
    return json({ error: 'API_ERROR', message: e.message }, 500);
  }
}

async function fetchQQQData(period, env) {
  const rangeMap     = { '1M': '1mo', '3M': '3mo', '1Y': '1y',  '3Y': '3y',  '5Y': '5y'  };
  const intervalMap  = { '1M': '1h',  '3M': '1d',  '1Y': '1wk', '3Y': '1mo', '5Y': '1mo' };
  const range    = rangeMap[period]    || '1mo';
  const interval = intervalMap[period] || '1d';

  // 5Y needs a different approach — use max range with monthly interval
  const yahooRange    = period === '5Y' ? '5y'  : range;
  const yahooInterval = period === '5Y' ? '1mo' : interval;

  let trend        = [];
  let currentPrice = 0;
  let prevClose    = 0;
  let change       = 0;
  let changePct    = 0;
  let high52       = 0;
  let low52        = 0;
  let volume       = '--';

  try {
    // Yahoo Finance — chart endpoint with split/div events for correct prices
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/QQQ?range=${yahooRange}&interval=${yahooInterval}&includePrePost=false&events=div%2Csplit&corsDomain=finance.yahoo.com`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com',
      }
    });

    if (res.ok) {
      const d = await res.json();
      const result = d?.chart?.result?.[0];
      if (result) {
        const meta       = result.meta        || {};
        const timestamps = result.timestamp   || [];
        const adjCloses  = result.indicators?.adjclose?.[0]?.adjclose || [];
        const rawCloses  = result.indicators?.quote?.[0]?.close       || [];
        const closes     = adjCloses.length > 0 ? adjCloses : rawCloses;

        // ── 当前价格（实时）──
        currentPrice = parseFloat((meta.regularMarketPrice || 0).toFixed(2));

        // After market close, regularMarketPrice = regularMarketPreviousClose (same value)
        // So we use regularMarketOpen to show today's intraday move,
        // falling back to regularMarketPreviousClose for pre-market
        const todayOpen = meta.regularMarketOpen || 0;
        prevClose = parseFloat((meta.regularMarketPreviousClose || currentPrice).toFixed(2));

        // If market is closed and price = prevClose, use open vs close for today's change
        if (Math.abs(currentPrice - prevClose) < 0.01 && todayOpen > 0) {
          change    = parseFloat((currentPrice - todayOpen).toFixed(2));
          changePct = parseFloat(((change / todayOpen) * 100).toFixed(2));
        } else {
          change    = parseFloat((currentPrice - prevClose).toFixed(2));
          changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        }

        high52 = parseFloat((meta.fiftyTwoWeekHigh || 0).toFixed(2));
        low52  = parseFloat((meta.fiftyTwoWeekLow  || 0).toFixed(2));
        volume = formatVolume(meta.regularMarketVolume || 0);

        // ── 趋势数组 ──
        trend = timestamps.map((ts, i) => {
          const p = closes[i];
          if (!p || p <= 0) return null;
          const dt = new Date(ts * 1000);
          // 小时数据显示 "5/8 14:00"，日/周/月数据显示 "5/8"
          const dateStr = interval === '1h'
            ? `${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours()}:00`
            : `${dt.getMonth()+1}/${dt.getDate()}`;
          return { date: dateStr, price: parseFloat(p.toFixed(2)) };
        }).filter(Boolean);
      }
    }
  } catch (e) {
    // Yahoo failed — AI will search for everything
  }

  // ── AI: 只搜索技术指标和宏观数据，价格用 Yahoo 的真实数据 ──
  const priceCtx = currentPrice > 0
    ? `I already have accurate QQQ price data from Yahoo Finance:
       Price: $${currentPrice}, Previous close: $${prevClose}, Change: $${change} (${changePct}%), 52wk high: $${high52}, 52wk low: $${low52}.
       DO NOT search for price. Only search for the indicators below.`
    : 'Search for current QQQ ETF price and all indicators below.';

  const prompt = `${priceCtx}

Search for ONLY these indicators:
1. VIX index current value
2. US 10-year treasury yield (%)
3. QQQ trailing P/E ratio
4. QQQ 14-day RSI
5. QQQ MACD signal: bullish, bearish, or neutral
6. QQQ 20-day moving average price
7. QQQ 200-day moving average price

Return ONLY this raw JSON, no markdown, no extra text:
{"price":${currentPrice},"change":${change},"changePct":${changePct},"high52":${high52},"low52":${low52},"volume":"${volume}","vix":number,"bond10y":number,"pe":number,"rsi":number,"macd":"bullish|bearish|neutral","ma20":number,"ma200":number}`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiRes.ok) throw new Error(`AI error ${aiRes.status}`);

  const aiData = await aiRes.json();
  const text   = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const match  = text.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error('No JSON in AI response');

  const parsed = JSON.parse(match[0]);

  // 确保用 Yahoo 的精确价格覆盖 AI 可能返回的不准确值
  if (currentPrice > 0) {
    parsed.price     = currentPrice;
    parsed.change    = change;
    parsed.changePct = changePct;
    parsed.high52    = high52;
    parsed.low52     = low52;
    parsed.volume    = volume;
  }

  parsed.trend     = trend;
  parsed.period    = period;
  parsed.fetchedAt = new Date().toISOString();
  return parsed;
}

function formatVolume(vol) {
  if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(0) + 'K';
  return String(vol);
}

// ── KV rate limiting ──────────────────────────────────────
const todayKey = ip => `usage:${ip}:${new Date().toISOString().slice(0, 10)}`;
const paidKey  = ip => `paid:${ip}`;

async function getUsage(ip, env) {
  const [raw, paidRaw] = await Promise.all([
    env.KV.get(todayKey(ip)),
    env.KV.get(paidKey(ip))
  ]);
  const isPaid = paidRaw === 'true';
  return { used: parseInt(raw || '0'), limit: isPaid ? PAID_LIMIT : FREE_LIMIT, isPaid };
}

async function incrementUsage(ip, env) {
  const key = todayKey(ip);
  const cur = parseInt((await env.KV.get(key)) || '0');
  const ttl = Math.ceil(86400 - (Date.now() / 1000 % 86400)) + 3600;
  await env.KV.put(key, String(cur + 1), { expirationTtl: ttl });
}

async function decrementUsage(ip, env) {
  const key = todayKey(ip);
  const cur = parseInt((await env.KV.get(key)) || '1');
  if (cur > 0) {
    const ttl = Math.ceil(86400 - (Date.now() / 1000 % 86400)) + 3600;
    await env.KV.put(key, String(cur - 1), { expirationTtl: ttl });
  }
}

// ── Stripe ────────────────────────────────────────────────
async function handleCheckout(request, env) {
  const ip     = getIP(request);
  const origin = request.headers.get('Origin') || `https://${env.GITHUB_PAGES_DOMAIN}`;
  const params = new URLSearchParams({
    'mode': 'subscription',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    'success_url': `${origin}/?session_id={CHECKOUT_SESSION_ID}&status=success`,
    'cancel_url':  `${origin}/?status=cancelled`,
    'metadata[ip]': ip,
    'allow_promotion_codes': 'true',
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const session = await res.json();
  if (session.error) return json({ error: session.error.message }, 400);
  return json({ url: session.url });
}

async function handleWebhook(request, env) {
  const body = await request.text();
  const sig  = request.headers.get('stripe-signature');
  let event;
  try { event = await verifyStripe(body, sig, env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return new Response(`Webhook error: ${e.message}`, { status: 400 }); }
  if (event.type === 'checkout.session.completed') {
    const ip = event.data.object?.metadata?.ip;
    if (ip) await env.KV.put(paidKey(ip), 'true', { expirationTtl: 90 * 86400 });
  }
  if (event.type === 'customer.subscription.deleted') {
    const ip = event.data.object?.metadata?.ip;
    if (ip) await env.KV.delete(paidKey(ip));
  }
  return new Response('ok');
}

async function handleVerify(request, env) {
  const sessionId = new URL(request.url).searchParams.get('session_id');
  if (!sessionId) return json({ error: 'Missing session_id' }, 400);
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const session = await res.json();
  if (session.payment_status === 'paid' || session.status === 'complete') {
    const ip = getIP(request);
    await env.KV.put(paidKey(ip), 'true', { expirationTtl: 90 * 86400 });
    return json({ success: true, isPaid: true });
  }
  return json({ success: false, isPaid: false });
}

async function verifyStripe(body, sigHeader, secret) {
  const parts   = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const payload = `${parts.t}.${body}`;
  const enc     = new TextEncoder();
  const key     = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig     = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const hex     = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== parts.v1) throw new Error('Invalid signature');
  if (Math.floor(Date.now() / 1000) - parseInt(parts.t) > 300) throw new Error('Expired');
  return JSON.parse(body);
}

// ── Helpers ───────────────────────────────────────────────
function getIP(req) {
  return req.headers.get('CF-Connecting-IP')
    || (req.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || '0.0.0.0';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
