/* =====================================================================
   Degen Desk  -  Stripe paid-member code Worker  ("dd-pay")
   Block Wall Street LLC

   What it does
   - After someone pays on the Degen Desk Stripe Payment Link, Stripe sends
     them to codebwsddp.html?session_id=...  That page calls  GET /claim
     here. This Worker asks Stripe if that checkout was really paid, then
     makes ONE unique code for that payment (example: DD-7K4P-Q2MX) tied to
     the buyer's email. Refreshing the page shows the same code again.
   - The front page sends codes that look like DD-XXXX-XXXX to  POST /redeem.
     The code only works with the email used at checkout and gives 30 days
     from the day it is first entered. Every new payment = a new code.
   - Optional: POST /webhook (Stripe "checkout.session.completed") makes the
     code even if the buyer closes the page, and emails it to them if you
     add a Resend key.

   Settings (Cloudflare > Workers > dd-pay > Settings > Variables)
   - STRIPE_SECRET_KEY      (Secret, required)  a Stripe restricted key with
                            "Checkout Sessions: Read" is enough (rk_live_...)
   - DD_CODES               (KV namespace binding, required)
   - PAYMENT_LINK_ID        (Text, optional)  plink_...  only accept payments
                            from the Degen Desk link
   - STRIPE_WEBHOOK_SECRET  (Secret, optional)  whsec_...  for /webhook
   - RESEND_API_KEY         (Secret, optional)  emails the code to the buyer
   - MAIL_FROM              (Text, optional)  e.g. Degen Desk <desk@blockwallstreet.biz>
   ===================================================================== */

const SITE = "https://degendesk.blockwallstreet.biz";
const ALLOWED_ORIGINS = [SITE, "https://blockwallstreethub.github.io"];
const DAYS = 30;
const DAY_MS = 86400000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : SITE,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/claim" && req.method === "GET") return json(await claim(url, env), cors);
      if (url.pathname === "/redeem" && req.method === "POST") return json(await redeem(req, env), cors);
      if (url.pathname === "/webhook" && req.method === "POST") return await webhook(req, env);
      if (url.pathname === "/" ) return json({ ok: true, service: "dd-pay" }, cors);
      return json({ ok: false, error: "Not found" }, cors, 404);
    } catch (e) {
      return json({ ok: false, error: "Server error. Try again in a minute." }, cors, 500);
    }
  },
};

/* ---------- GET /claim?session_id=cs_... ---------- */
async function claim(url, env) {
  const sid = (url.searchParams.get("session_id") || "").trim();
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sid)) return { ok: false, error: "This link is missing the payment number. Open the link Stripe sent you after paying." };
  const s = await stripeSession(sid, env);
  if (!s) return { ok: false, error: "We could not find that payment." };
  const check = paidCheck(s, env);
  if (check) return { ok: false, error: check };
  const rec = await issue(s, env, false);
  return { ok: true, code: rec.code, email: rec.email, days: DAYS, used: !!rec.first };
}

/* ---------- POST /redeem {code,email} ---------- */
async function redeem(req, env) {
  const b = await req.json().catch(() => ({}));
  const code = String(b.code || "").trim().toUpperCase();
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^DD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { ok: false, error: "That code is not right. Check it and try again." };
  const raw = await env.DD_CODES.get("c:" + code);
  if (!raw) return { ok: false, error: "That code is not right. Check it and try again." };
  const rec = JSON.parse(raw);
  if (rec.email && email !== rec.email) return { ok: false, error: "Use the same email you paid with (" + mask(rec.email) + ")." };
  const now = Date.now();
  if (!rec.first) { rec.first = now; await env.DD_CODES.put("c:" + code, JSON.stringify(rec)); }
  const exp = rec.first + DAYS * DAY_MS;
  if (now >= exp) return { ok: false, error: "Your 30 days with this code have ended. Use Get access to renew and get a new code." };
  return { ok: true, exp: new Date(exp).toISOString(), tier: "paid" };
}

/* ---------- POST /webhook (Stripe) ---------- */
async function webhook(req, env) {
  const body = await req.text();
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("webhook secret not set", { status: 400 });
  const ok = await verifyStripeSig(body, req.headers.get("Stripe-Signature") || "", env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 400 });
  const evt = JSON.parse(body);
  if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
    const s = evt.data.object;
    if (!paidCheck(s, env)) await issue(s, env, true);
  }
  return new Response("ok");
}

/* ---------- helpers ---------- */
function paidCheck(s, env) {
  if (env.PAYMENT_LINK_ID && s.payment_link !== env.PAYMENT_LINK_ID) return "That payment is not for the Degen Desk.";
  if (s.status !== "complete" || s.payment_status !== "paid") return "That payment has not gone through yet. If you just paid, wait a minute and refresh this page.";
  return "";
}

async function issue(s, env, sendMail) {
  const key = "s:" + s.id;
  const have = await env.DD_CODES.get(key);
  if (have) {
    const r = await env.DD_CODES.get("c:" + have);
    if (r) return JSON.parse(r);
  }
  const email = String((s.customer_details && s.customer_details.email) || s.customer_email || "").toLowerCase();
  let code;
  for (let i = 0; i < 6; i++) {
    code = makeCode();
    if (!(await env.DD_CODES.get("c:" + code))) break;
  }
  const rec = {
    code, email,
    name: (s.customer_details && s.customer_details.name) || "",
    session: s.id,
    amount: (s.amount_total || 0) / 100,
    currency: s.currency || "usd",
    issued: Date.now(),
    first: 0,
  };
  await env.DD_CODES.put("c:" + code, JSON.stringify(rec));
  await env.DD_CODES.put(key, code);
  if (sendMail || env.RESEND_API_KEY) await mailCode(rec, env);
  return rec;
}

function makeCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return "DD-" + s.slice(0, 4) + "-" + s.slice(4);
}

async function stripeSession(id, env) {
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY },
  });
  if (!r.ok) return null;
  return r.json();
}

async function mailCode(rec, env) {
  if (!env.RESEND_API_KEY || !rec.email) return;
  const sentKey = "m:" + rec.code;
  if (await env.DD_CODES.get(sentKey)) return;
  const html =
    '<div style="font-family:Arial,sans-serif;background:#070D1B;color:#E6ECFA;padding:28px;border-radius:10px">' +
    '<h2 style="margin:0 0 8px;color:#35F0FF">Welcome to the Block Wall Street Degen Desk</h2>' +
    "<p>Thank you for your payment. Here is your personal member code:</p>" +
    '<p style="font-size:26px;letter-spacing:3px;font-family:Consolas,monospace;background:#101B38;border:1px solid #1F2D52;padding:14px 18px;border-radius:8px;color:#fff;display:inline-block">' + rec.code + "</p>" +
    "<p>1. Go to <a style=\"color:#8CF7FF\" href=\"" + SITE + "/\">" + SITE.replace("https://", "") + "</a><br>" +
    "2. Enter this email: <b>" + rec.email + "</b><br>3. Enter your code and press Enter.</p>" +
    "<p>Your 30 days start the day you first enter the code. Start with the Degen Desk course: it walks you through every tool.</p>" +
    '<p style="color:#8E9BC0;font-size:12px">This code only works with your email. Please don\'t share it. Block Wall Street LLC, Chicago.</p></div>';
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM || "Degen Desk <onboarding@resend.dev>",
      to: [rec.email],
      subject: "Your Degen Desk member code: " + rec.code,
      html,
    }),
  });
  if (r.ok) await env.DD_CODES.put(sentKey, "1");
}

async function verifyStripeSig(body, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2));
  const t = parts.t, v1s = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body));
  const hex = [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return v1s.includes(hex);
}

function mask(e) {
  const [u, d] = e.split("@");
  return (u.slice(0, 2) + "***@" + (d || ""));
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
