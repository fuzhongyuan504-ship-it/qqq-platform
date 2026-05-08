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
  const label = { '1M':'30天', '3M':'3个月', '1Y':'1年', '3Y':'3年' }[period] || '30天';
  const pts   = { '1M': 22, '3M': 60, '1Y': 12, '3Y': 12 }[period] || 22;
  const prompt = `Search for current QQQ ETF data right now. Return ONLY a raw JSON object — no markdown, no backticks, no explanation.\n\nFind: current price, today's change & %, 52-week high & low, VIX, US 10Y yield, QQQ P/E, volume, RSI(14), MACD signal, MA20, MA200, and ~${pts} historical closing prices for the past ${label}.\n\nReturn exactly:\n{"price":number,"change":number,"changePct":number,"high52":number,"low52":number,"vix":number,"bond10y":number,"pe":number,"volume":"string","rsi":number,"macd":"bullish|bearish|neutral","ma20":number,"ma200":number,"trend":[{"date":"MM/DD","price":number}],"period":"${period}"}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const apiData = await res.json();
  const text = (apiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON returned');
  const parsed = JSON.parse(match[0]);
  parsed.fetchedAt = new Date().toISOString();
  return parsed;
}

const todayKey = ip => `usage:${ip}:${new Date().toISOString().slice(0, 10)}`;
const paidKey  = ip => `paid:${ip}`;

async function getUsage(ip, env) {
  const [raw, paidRaw] = await Promise.all([env.KV.get(todayKey(ip)), env.KV.get(paidKey(ip))]);
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

async function handleCheckout(request, env) {
  const ip = getIP(request);
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
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const payload = `${parts.t}.${body}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== parts.v1) throw new Error('Invalid signature');
  if (Math.floor(Date.now() / 1000) - parseInt(parts.t) > 300) throw new Error('Expired');
  return JSON.parse(body);
}

function getIP(req) {
  return req.headers.get('CF-Connecting-IP')
    || (req.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || '0.0.0.0';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
