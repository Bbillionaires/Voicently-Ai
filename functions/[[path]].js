// Cloudflare Pages Functions backend for Voicently
// Routes:
//  GET  /api/health
//  POST /api/leads
//  POST /api/orders
//  POST /api/stripe/create-payment-intent
//  POST /api/stripe/webhook
//  POST /api/paypal/create-order
//  POST /api/paypal/capture-order
//  POST /api/square/create-payment
//  GET  /api/videos
//  POST /api/videos/upload        (admin; supports R2 upload OR externalUrl JSON)
//  POST /api/funnel/track
//
// Bindings/Vars expected (Pages → Settings):
//  D1:      DB
//  (opt) R2: STORAGE
//  ADMIN_API_KEY
//  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//  PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_MODE ("sandbox"|"live")
//  SQUARE_ACCESS_TOKEN, SQUARE_ENV ("sandbox"|"production")
//  (opt) GOOGLE_SHEETS_URL
//  (opt) PUBLIC_R2_URL_PREFIX

// ==================== PAGES WRAPPER ====================
export async function onRequest(context) {
  const { request, env } = context;
  return handleRequest(request, env);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  };
  if (method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    // Health
    if (path === "/api/health" && method === "GET") {
      return jsonResponse(
        { ok: true, hasDB: !!env.DB, hasR2: !!env.STORAGE },
        CORS
      );
    }

    // Leads
    if (path === "/api/leads" && method === "POST") {
      return await createLead(request, env, CORS);
    }

    // Orders
    if (path === "/api/orders" && method === "POST") {
      return await createOrder(request, env, CORS);
    }

    // Stripe
    if (path === "/api/stripe/create-payment-intent" && method === "POST") {
      return await createStripePayment(request, env, CORS);
    }
    if (path === "/api/stripe/webhook" && method === "POST") {
      return await handleStripeWebhook(request, env, CORS);
    }

    // PayPal
    if (path === "/api/paypal/create-order" && method === "POST") {
      return await createPayPalOrder(request, env, CORS);
    }
    if (path === "/api/paypal/capture-order" && method === "POST") {
      return await capturePayPalOrder(request, env, CORS);
    }

    // Square
    if (path === "/api/square/create-payment" && method === "POST") {
      return await createSquarePayment(request, env, CORS);
    }

    // Videos
    if (path === "/api/videos" && method === "GET") {
      return await getVideos(request, env, CORS);
    }
    if (path === "/api/videos/upload" && method === "POST") {
      return await uploadVideo(request, env, CORS); // <-- dual-mode version below
    }

    // Funnel
    if (path === "/api/funnel/track" && method === "POST") {
      return await trackFunnelStep(request, env, CORS);
    }

    return jsonResponse({ error: "Not Found" }, CORS, 404);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, CORS, 500);
  }
}

// ==================== LEADS ====================
async function createLead(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  const res = await env.DB.prepare(
    `INSERT INTO leads (name,email,phone,company,source)
     VALUES (?,?,?,?,?)`
  ).bind(
    data.name || "",
    data.email || "",
    data.phone || "",
    data.company || null,
    data.source || "landing_page"
  ).run();

  if (env.GOOGLE_SHEETS_URL) {
    // Best-effort forward to Google Apps Script
    fetch(env.GOOGLE_SHEETS_URL, {
      method: "POST",
      body: JSON.stringify(data)
    }).catch(() => {});
  }

  return jsonResponse({ success: true, leadId: res.meta?.last_row_id || null }, CORS);
}

// ==================== ORDERS ====================
async function createOrder(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  const res = await env.DB.prepare(
    `INSERT INTO orders (
      lead_id, plan_type, plan_price,
      upsell_accepted, upsell_price,
      downsell_accepted, downsell_price,
      total_amount, payment_method, payment_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    data.leadId,
    data.planType,
    data.planPrice,
    data.upsellAccepted ? 1 : 0,
    data.upsellPrice || 0,
    data.downsellAccepted ? 1 : 0,
    data.downsellPrice || 0,
    data.totalAmount,
    data.paymentMethod || "stripe",
    "pending"
  ).run();

  return jsonResponse({ success: true, orderId: res.meta?.last_row_id || null }, CORS);
}

// ==================== STRIPE ====================
async function createStripePayment(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  requireEnv(env, ["STRIPE_SECRET_KEY"]);

  const params = new URLSearchParams();
  params.set("amount", String(Math.round((data.amount || 0) * 100))); // cents
  params.set("currency", "usd");
  if (data.orderId) params.set("metadata[order_id]", String(data.orderId));
  if (data.leadId)  params.set("metadata[lead_id]", String(data.leadId));

  const r = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const pi = await r.json();
  if (pi.error) return jsonResponse({ error: pi.error.message }, CORS, 400);

  await env.DB.prepare(`UPDATE orders SET stripe_payment_id = ? WHERE id = ?`)
    .bind(pi.id, data.orderId).run();

  return jsonResponse({ clientSecret: pi.client_secret, paymentIntentId: pi.id }, CORS);
}

async function handleStripeWebhook(request, env, CORS) {
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature") || "";
  requireEnv(env, ["STRIPE_WEBHOOK_SECRET"]);

  // Minimal signature check (HMAC-SHA256) for v1
  const parts = Object.fromEntries(sig.split(",").map(s => s.trim().split("=", 2)));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return jsonResponse({ error: "Bad signature" }, CORS, 400);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const computed = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (computed !== v1) return jsonResponse({ error: "Signature mismatch" }, CORS, 400);

  const event = JSON.parse(payload);

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    await env.DB.prepare(
      `UPDATE orders SET payment_status='completed' WHERE stripe_payment_id = ?`
    ).bind(pi.id).run();

    const order = await env.DB.prepare(`SELECT * FROM orders WHERE stripe_payment_id=?`)
      .bind(pi.id).first();
    if (order) await createUserFromOrder(order, env);
  }

  return jsonResponse({ received: true }, CORS);
}

// ==================== PAYPAL ====================
function paypalBase(env) {
  const live = env.PAYPAL_MODE === "live";
  return {
    token:  live ? "https://api-m.paypal.com/v1/oauth2/token"
                 : "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    orders: live ? "https://api-m.paypal.com/v2/checkout/orders"
                 : "https://api-m.sandbox.paypal.com/v2/checkout/orders"
  };
}
async function paypalToken(env) {
  requireEnv(env, ["PAYPAL_CLIENT_ID", "PAYPAL_SECRET"]);
  const { token } = paypalBase(env);
  const r = await fetch(token, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("PayPal token error");
  return j.access_token;
}
async function createPayPalOrder(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  const { orders } = paypalBase(env);
  const access = await paypalToken(env);

  const r = await fetch(orders, {
    method: "POST",
    headers: { "Authorization": `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "USD", value: String(data.amount || 0) },
        description: `Voicently ${data.planType || "Plan"}`
      }]
    })
  });
  const order = await r.json();
  if (!order.id) return jsonResponse({ error: "PayPal order error" }, CORS, 400);
  return jsonResponse({ orderId: order.id }, CORS);
}
async function capturePayPalOrder(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  const { orders } = paypalBase(env);
  const access = await paypalToken(env);

  const r = await fetch(`${orders}/${data.orderId}/capture`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${access}`, "Content-Type": "application/json" }
  });
  const capture = await r.json();

  if (capture.status === "COMPLETED") {
    await env.DB.prepare(
      `UPDATE orders SET payment_status='completed', paypal_transaction_id=? WHERE id=?`
    ).bind(capture.id, data.dbOrderId).run();

    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`)
      .bind(data.dbOrderId).first();
    if (order) await createUserFromOrder(order, env);

    return jsonResponse({ success: true, capture }, CORS);
  }
  return jsonResponse({ error: "PayPal capture failed", capture }, CORS, 400);
}

// ==================== SQUARE ====================
function squareBase(env) {
  return env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}
async function createSquarePayment(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  requireEnv(env, ["SQUARE_ACCESS_TOKEN"]);
  const base = squareBase(env);

  const r = await fetch(`${base}/v2/payments`, {
    method: "POST",
    headers: {
      "Square-Version": "2023-10-18",
      "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_id: data.sourceId, // from Square Web Payments SDK on client
      amount_money: { amount: Math.round((data.amount || 0) * 100), currency: "USD" },
      idempotency_key: crypto.randomUUID()
    })
  });
  const j = await r.json();

  if (j.payment && j.payment.status === "COMPLETED") {
    await env.DB.prepare(
      `UPDATE orders SET payment_status='completed', square_payment_id=? WHERE id=?`
    ).bind(j.payment.id, data.orderId).run();

    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`)
      .bind(data.orderId).first();
    if (order) await createUserFromOrder(order, env);

    return jsonResponse({ success: true, payment: j.payment }, CORS);
  }
  return jsonResponse({ error: "Square payment failed", details: j }, CORS, 400);
}

// ==================== VIDEOS ====================
async function getVideos(_request, env, CORS) {
  const { results } = await env.DB.prepare(
    `SELECT id,title,description,video_url,video_type,thumbnail_url
     FROM videos WHERE is_active=1
     ORDER BY display_order ASC, created_at DESC`
  ).all();
  return jsonResponse({ videos: results || [] }, CORS);
}

// ---- Dual-mode upload: R2 file upload OR externalUrl JSON (no R2) ----
async function uploadVideo(request, env, CORS) {
  // Admin-protected
  if ((request.headers.get("X-API-Key") || "") !== (env.ADMIN_API_KEY || "")) {
    return jsonResponse({ error: "Unauthorized" }, CORS, 401);
  }

  // If R2 is available, support multipart file upload
  if (env.STORAGE) {
    const form = await request.formData();
    const file = form.get("file");
    const title = form.get("title") || "";
    const description = form.get("description") || "";
    const type = form.get("type") || "demo";
    if (!file) return jsonResponse({ error: "file required" }, CORS, 400);

    const key = `videos/${type}/${Date.now()}-${(file.name || "upload").replace(/\s+/g, "_")}`;
    await env.STORAGE.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "video/mp4" }
    });

    const url = env.PUBLIC_R2_URL_PREFIX
      ? `${env.PUBLIC_R2_URL_PREFIX.replace(/\/+$/,"")}/${key}`
      : `r2://${key}`;

    const res = await env.DB.prepare(
      `INSERT INTO videos (title,description,video_url,video_type,r2_key,file_size,is_active)
       VALUES (?,?,?,?,?,?,1)`
    ).bind(title, description, url, type, key, file.size || 0).run();

    return jsonResponse({ success: true, videoId: res.meta?.last_row_id || null, url }, CORS);
  }

  // No R2: accept JSON with externalUrl (YouTube/Drive/S3/Supabase link)
  const data = await request.json().catch(() => ({}));
  const title = data.title || "";
  const description = data.description || "";
  const type = data.type || "demo";
  const externalUrl = data.externalUrl;
  if (!externalUrl) {
    return jsonResponse({ error: "externalUrl required (no R2 bound)" }, CORS, 400);
  }

  const res = await env.DB.prepare(
    `INSERT INTO videos (title,description,video_url,video_type,is_active)
     VALUES (?,?,?,?,1)`
  ).bind(title, description, externalUrl, type).run();

  return jsonResponse({
    success: true,
    videoId: res.meta?.last_row_id || null,
    url: externalUrl,
    storage: "external-url"
  }, CORS);
}

// ==================== FUNNEL ====================
async function trackFunnelStep(request, env, CORS) {
  const data = await request.json().catch(() => ({}));
  await env.DB.prepare(
    `INSERT INTO funnel_analytics (lead_id, step_name, action, metadata)
     VALUES (?,?,?,?)`
  ).bind(
    data.leadId || null,
    data.stepName || "",
    data.action || "",
    JSON.stringify(data.metadata || {})
  ).run();
  return jsonResponse({ success: true }, CORS);
}

// ==================== HELPERS ====================
async function createUserFromOrder(order, env) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id=?`)
    .bind(order.lead_id).first();
  if (!lead) return;

  const userRes = await env.DB.prepare(
    `INSERT INTO users (email,full_name,phone,company,role)
     VALUES (?,?,?,?, 'client')`
  ).bind(lead.email || "", lead.name || "", lead.phone || "", lead.company || "").run();

  const userId = userRes.meta?.last_row_id;

  await env.DB.prepare(
    `INSERT INTO clients (user_id,order_id,onboarding_status,api_key)
     VALUES (?,?, 'pending', ?)`
  ).bind(userId, order.id, crypto.randomUUID()).run();

  if (order.plan_type && order.plan_type !== "one_time") {
    const next = new Date(); next.setMonth(next.getMonth() + 1);
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id,order_id,plan_type,monthly_price,next_billing_date)
       VALUES (?,?,?,?,?)`
    ).bind(
      userId, order.id, order.plan_type, order.plan_price || 0, next.toISOString().slice(0,10)
    ).run();
  }
  // TODO: send welcome email via your provider
  console.log(`Welcome email queued for ${lead.email}`);
  return userId;
}

function jsonResponse(data, CORS, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

function requireEnv(env, keys) {
  const missing = keys.filter(k => !env[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}
