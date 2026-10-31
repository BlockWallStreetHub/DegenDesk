// Moon Desk "Ask" helper for Cloudflare Workers.
// It sits between your website and the AI service so your secret key is never exposed in the web page.
// Settings (Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret, required)  your key from console.anthropic.com
//   ALLOWED_ORIGIN     (Text, optional)    default https://degendesk.blockwallstreet.biz
//   MODEL              (Text, optional)    default claude-sonnet-5-5
//   ACCESS_CODE        (Text, optional)    the code people must enter to use the box, default BBBDD
//   DAILY_LIMIT        (Text, optional)    total questions per day for everyone, default 300
//   PER_IP_LIMIT       (Text, optional)    questions per person per day, default 20
// Optional but recommended: bind a KV namespace called LIMITS so the daily limits survive restarts.

const PLAN_PROMPT = `You turn a person's what-if question about a moon-based trading back-test into a JSON test plan. The back-test engine already exists; you only choose its settings. Reply with ONE JSON object and nothing else (no markdown fences).

The user message gives: the question, the asset name, the price history dates, and "panel" = the person's current settings. Any rule you do not mention in a run's "spec" is inherited from the panel, so only put in a spec the things that CHANGE for that run.

Output shape:
{"runs":[{"label":"short plain name","spec":{...}}, ...],"note":"optional one sentence about an assumption you made","unsupported":null}
- 1 to 4 runs. For "compare A vs B" use one run each. For "what if I do X", use 2 runs: the person's current setup as the first run (spec can be {}) and the change as the second. Buy-and-hold is always added automatically, never add it.
- If the question cannot be expressed with the rules below, return {"runs":[],"unsupported":"one short plain sentence saying what is missing"}.
- If the question is not about testing a strategy at all, return unsupported with a friendly sentence.

Spec fields (all optional):
- phases: array of moon phase numbers the strategy is invested during. 0 New Moon, 1 Waxing Crescent, 2 First Quarter, 3 Waxing Gibbous, 4 Full Moon, 5 Waning Gibbous, 6 Last Quarter, 7 Waning Crescent. "Waxing" = [0,1,2,3], "waning" = [4,5,6,7], all = [0,1,2,3,4,5,6,7].
- signs: array of moon sign numbers. 0 Aries,1 Taurus,2 Gemini,3 Cancer,4 Leo,5 Virgo,6 Libra,7 Scorpio,8 Sagittarius,9 Capricorn,10 Aquarius,11 Pisces. Fire=[0,4,8], Earth=[1,5,9], Air=[2,6,10], Water=[3,7,11]. "Skip Scorpio" = every number except 7.
- retro: "ignore" | "cash" (stay in cash during Mercury retrograde) | "only" (invested only during retrograde).
- eclipse: "ignore" | "cash" (cash within about 2 days of an eclipse) | "only".
- weekdays: array 0-6 (0 Sunday ... 6 Saturday) the strategy may be invested, or "all".
- leverage: 1 to 5 (borrowing costs are NOT modeled).
- stopLoss: percent (1-99) loss on a single trade that triggers selling, or null. takeProfit: percent gain that triggers selling, or null. Checked at each daily close.
- fee: percent charged on every buy and every sell. capital: starting dollars. from / to: "YYYY-MM-DD" dates inside the price history.
- compound: {"mode":"always"} reinvest all profits (default); {"mode":"never"} every time a trade ends with a profit, the profit is taken out as cash and only the original stake keeps trading; {"mode":"when","when":{...}} profits are reinvested only on days matching ALL conditions in "when": retro (true = Mercury retrograde, false = not), eclipse (true/false), phases (array), signs (array). When the condition is false at that moment, profits are taken out as cash instead. Cash taken out is added back into the stake at the next buy that happens on a compounding day.

Rules for good plans:
- Labels are short and in plain English (e.g. "Compound only in retrograde"), never mention JSON or field names.
- Interpret everyday words generously but honestly. State any assumption in "note".
- Never invent data outside the price history. If the person names dates outside it, clamp them to it and say so in "note".
- Do not give financial advice; you only configure tests.

Example question: "What if I compound only during Mercury retrograde?"
{"runs":[{"label":"Compound all the time","spec":{"compound":{"mode":"always"}}},{"label":"Compound only in retrograde","spec":{"compound":{"mode":"when","when":{"retro":true}}}}],"note":"Profits made outside retrograde are taken out as cash.","unsupported":null}

Example question: "Compare only full moons vs only new moons"
{"runs":[{"label":"Full moon only","spec":{"phases":[4]}},{"label":"New moon only","spec":{"phases":[0]}}],"unsupported":null}`;

const EXPLAIN_PROMPT = `You explain back-test results to a crypto-education student in friendly plain English. You get the question and the computed results as JSON. Rules:
- Use ONLY the numbers given. Never invent or recalculate numbers.
- 2 to 4 short paragraphs, under 200 words total. Start by directly answering the question (which setup ended higher, by how many dollars and points, versus buy and hold).
- Mention one honest caution that fits the results (few trades, bigger drops, results from one asset and date range, luck vs a real edge). Do not call anything a strategy to follow.
- End with: "This is a back-test of past prices, not a prediction or financial advice."
- Bold key numbers with **double asterisks**. No headings, no bullet lists.`;

const STRATEGY_PROMPT = `You write a plain-English trading-calendar strategy for a crypto-education student, based ONLY on a moon-cycle back-test the app already ran. You get JSON: the asset, today's date, the exact rules, the history of how those rules did, whether the rules are invested right now, and the upcoming buy and sell windows already computed.
Rules:
- Use only the dates, numbers and reasons in the JSON. Never invent prices, targets, dates or percentages. Do not recompute anything.
- Write 4 short sections, each starting with a bold lead-in on its own line, using **double asterisks**, then 1 to 3 sentences:
  **The plan.** (what the rules say to do in the next window: buy date/time, sell date/time, reason, with Chicago times as given)
  **What history says.** (win rate, average trade, best and worst trade, versus buy and hold, and the last 12 months)
  **How much to trust it.** (be honest: use beatFakeCalendarsPct, number of trades, one asset and one date range; say luck is a real possibility when it is below about 95)
  **Keeping risk small.** (general education: only money you can afford to lose, size positions small, the worst drop in history, the rules can be wrong; no leverage advice, no promises)
- If there are several upcoming windows, summarise the first two clearly and mention the rest in one sentence.
- Plain, calm tone. No hype. Under 260 words total. End with: "This is a back-test of past prices, not a prediction or financial advice."`;

const mem = new Map();

function cors(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": origin === allowed ? origin : allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, h) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...h } });
}
async function bump(env, key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `${day}:${key}`;
  let n;
  if (env.LIMITS) {
    n = parseInt((await env.LIMITS.get(k)) || "0", 10) + 1;
    await env.LIMITS.put(k, String(n), { expirationTtl: 172800 });
  } else {
    n = (mem.get(k) || 0) + 1;
    mem.set(k, n);
    if (mem.size > 5000) mem.clear();
  }
  return n <= limit;
}
function pickJson(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no json");
  return JSON.parse(text.slice(a, b + 1));
}
const LENDING_PROMPT = `You are the Lending Manager helper inside a crypto-education tool called Degen Desk. A student asks a question about their own DeFi lending positions (Aave, Morpho, Kamino, Jupiter Lend and similar). You get JSON: their question, optional earlier questions, and "data" with their live positions: settings (floor health factor, the market drop they stress-test, caution and danger lines), accounts (health factor, collateral and debt per asset in USD, liquidation prices, health factor after assumed drops, trend versus weekly and monthly 20 EMA, and what the rule-based manager already said), and other lending accounts.
Rules:
- Use ONLY the numbers in the JSON. Never invent prices, rates, balances or health factors. If something needed is missing, say so.
- Answer the question directly first (for example "Not yet", "Yes, add collateral", "Repay first"), then give the 2 to 5 reasons using their actual numbers.
- Know the tools: ADD COLLATERAL or REPAY DEBT are the only moves that reliably raise health factor today. A COLLATERAL SWAP (volatile to stablecoin) lowers price sensitivity but barely changes health factor when it is already near 1. A swap INTO a volatile coin adds risk. A DEBT SWAP from stablecoin debt into a volatile coin is a leveraged short on that coin: it only makes sense with a healthy health factor and room to carry a rise. A debt swap from volatile debt back to stablecoin ends the short.
- Their playbook: keep health factor above the floor; secure the floor by moving volatile collateral to stablecoin if the stress drop would break it; consider a debt-swap short only when the coin has lost BOTH the weekly and monthly 20 EMA; swap stablecoin collateral into ETH only after health factor has risen the set percent above the reference. Respect these unless asked otherwise.
- Give rough sizes when you can, from their numbers, and say they are estimates. Mention swap fees and slippage once if you suggest a swap.
- Do not promise outcomes, do not predict prices, never tell them to borrow more or use more leverage to chase gains. If health factor is under 1.1 or inside their danger line, lead with the urgency.
- This is education, not financial advice; say that in one short closing sentence, not more.
- Plain English, friendly, under 220 words, short paragraphs, no markdown headings. Bold is not available; use plain text only.`;

async function claude(env, system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.MODEL || "claude-sonnet-5-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("ai " + r.status);
  const j = await r.json();
  return (j.content || []).map((c) => c.text || "").join("");
}

export default {
  async fetch(req, env) {
    const allowed = env.ALLOWED_ORIGIN || "https://degendesk.blockwallstreet.biz";
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin, allowed);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return json({ error: "Use POST." }, 405, h);
    if (origin !== allowed) return json({ error: "This helper only answers the Degen Desk site." }, 403, h);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The helper has no AI key yet." }, 500, h);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400, h); }
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const code = String(env.ACCESS_CODE || "BBBDD").trim().toUpperCase();
    if (String(body.code || "").trim().toUpperCase() !== code) {
      await bump(env, "bad:" + ip, 10);
      const tries = parseInt((env.LIMITS ? await env.LIMITS.get(new Date().toISOString().slice(0, 10) + ":bad:" + ip) : mem.get(new Date().toISOString().slice(0, 10) + ":bad:" + ip)) || "0", 10);
      if (tries > 10) return json({ error: "Too many wrong codes today. Try again tomorrow." }, 429, h);
      return json({ error: "That access code is not right.", badCode: true }, 401, h);
    }
    const perIp = parseInt(env.PER_IP_LIMIT || "20", 10), total = parseInt(env.DAILY_LIMIT || "300", 10);
    if (body.mode === "plan") {
      if (!(await bump(env, "ip:" + ip, perIp))) return json({ error: "You have used today's questions. Come back tomorrow." }, 429, h);
      if (!(await bump(env, "all", total))) return json({ error: "The Moon Desk AI is resting for today. Try again tomorrow." }, 429, h);
    }
    if (body.mode === "check") return json({ ok: true }, 200, h);
    if (body.mode === "strategy" || body.mode === "lending") {
      if (!(await bump(env, "ip:" + ip, perIp))) return json({ error: "You have used today's questions. Come back tomorrow." }, 429, h);
      if (!(await bump(env, "all", total))) return json({ error: "The Moon Desk AI is resting for today. Try again tomorrow." }, 429, h);
    }
    try {
      if (body.mode === "strategy") {
        const user = JSON.stringify(body.data || {});
        if (user.length > 12000 || user.length < 20) return json({ error: "Request too large." }, 400, h);
        const out = await claude(env, STRATEGY_PROMPT, user, 1200);
        return json({ text: out.trim() }, 200, h);
      }
      if (body.mode === "lending") {
        const q = String(body.question || "").slice(0, 600);
        if (q.length < 5) return json({ error: "Ask a longer question." }, 400, h);
        const hist = (Array.isArray(body.history) ? body.history : []).slice(-3).map((x) => ({ q: String(x.q || "").slice(0, 300), a: String(x.a || "").slice(0, 700) }));
        const user = JSON.stringify({ question: q, earlier: hist, data: body.data || {} });
        if (user.length > 24000) return json({ error: "Request too large." }, 400, h);
        const out = await claude(env, LENDING_PROMPT, user, 900);
        return json({ text: out.trim() }, 200, h);
      }
      if (body.mode === "plan") {
        const q = String(body.question || "").slice(0, 500);
        if (q.length < 5) return json({ error: "Ask a longer question." }, 400, h);
        const user = JSON.stringify({ question: q, asset: String(body.asset || "").slice(0, 60), priceHistory: { from: body.dataFrom, to: body.dataTo }, panel: body.panel });
        if (user.length > 6000) return json({ error: "Request too large." }, 400, h);
        const out = await claude(env, PLAN_PROMPT, user, 1200);
        return json({ plan: pickJson(out) }, 200, h);
      }
      if (body.mode === "explain") {
        const user = JSON.stringify({ question: String(body.question || "").slice(0, 500), asset: String(body.asset || "").slice(0, 60), results: body.results });
        if (user.length > 8000) return json({ error: "Request too large." }, 400, h);
        const out = await claude(env, EXPLAIN_PROMPT, user, 600);
        return json({ text: out.trim() }, 200, h);
      }
      return json({ error: "Unknown request." }, 400, h);
    } catch (e) {
      return json({ error: "The AI could not answer just now. Try again." }, 502, h);
    }
  },
};
