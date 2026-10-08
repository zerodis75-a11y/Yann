require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "ADMIN_KEY", "FLW_SECRET_KEY", "FLW_WEBHOOK_HASH"]) {
  if (!process.env[k]) { console.error("Missing env var: " + k); process.exit(1); }
}
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_KEY, FLW_SECRET_KEY, FLW_WEBHOOK_HASH } = process.env;
const BANK = process.env.FLW_XAF_BANK || "FMM";
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const app = express();
app.use(express.json({ limit: "50kb" }));

const same = (a, b) => {
  a = Buffer.from(String(a || "")); b = Buffer.from(String(b || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const admin = (req, res, next) =>
  same(req.get("x-admin-key"), ADMIN_KEY) ? next() : res.status(401).json({ error: "Unauthorized" });

app.get("/health", (_req, res) => res.json({ ok: true }));

// Your order system calls this when an order is delivered. Safe to retry: the same order_id is only counted once.
app.post("/api/admin/orders/delivered", admin, async (req, res) => {
  const { order_id, user_id, amount } = req.body || {};
  if (!order_id || !/^[0-9a-f-]{36}$/i.test(user_id || "") || !Number.isInteger(amount) || amount <= 0)
    return res.status(400).json({ error: "order_id, user_id (uuid) and amount (positive whole XAF) are required" });
  const { data, error } = await db.rpc("order_delivered", { p_order: String(order_id), p_user: user_id, p_amount: amount });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

async function pay(c) {
  const ref = "kwik-cashout-" + c.id;
  const { data: pr } = await db.from("profiles").select("name").eq("id", c.user_id).single();
  let r;
  try {
    r = await fetch("https://api.flutterwave.com/v3/transfers", {
      method: "POST",
      headers: { Authorization: "Bearer " + FLW_SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        account_bank: BANK, account_number: "237" + c.phone, amount: c.pts, currency: "XAF",
        narration: "Kwik Rewards cash out", reference: ref, beneficiary_name: (pr && pr.name) || "Member"
      })
    });
  } catch (e) {
    // Outcome unknown: do NOT refund or retry, or the user could be paid twice. Check the Flutterwave dashboard.
    return { id: c.id, status: "processing", note: "network error, check Flutterwave before retrying" };
  }
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.status === "success") return { id: c.id, status: "processing", note: "sent, waiting for webhook" };
  if (r.status >= 400 && r.status < 500) {
    await db.rpc("finish_cashout", { p_id: c.id, p_ok: false }); // clearly rejected: return the points
    return { id: c.id, status: "failed", note: j.message || "rejected by Flutterwave" };
  }
  return { id: c.id, status: "processing", note: "unclear response, check Flutterwave" };
}

let running = false;
async function runPayouts() {
  if (running) return [];
  running = true;
  try {
    const { data: rows, error } = await db.from("cashouts").select("id,user_id,phone,pts").eq("status", "pending").order("id").limit(20);
    if (error) throw error;
    const out = [];
    for (const c of rows) {
      // Claim the row first so two runs can never pay the same request.
      const { data: got } = await db.from("cashouts").update({ status: "processing" }).eq("id", c.id).eq("status", "pending").select("id");
      if (got && got.length) out.push(await pay(c));
    }
    return out;
  } finally { running = false; }
}

app.post("/api/admin/payouts/run", admin, async (_req, res) => {
  try { res.json({ processed: await runPayouts() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Set this URL as the webhook in the Flutterwave dashboard, with the same secret hash as FLW_WEBHOOK_HASH.
app.post("/api/webhooks/flutterwave", async (req, res) => {
  if (!same(req.get("verif-hash"), FLW_WEBHOOK_HASH)) return res.sendStatus(401);
  const d = (req.body && req.body.data) || {};
  const m = /^kwik-cashout-(\d+)$/.exec(d.reference || "");
  if (m) {
    const st = String(d.status || "").toUpperCase();
    if (st === "SUCCESSFUL") await db.rpc("finish_cashout", { p_id: Number(m[1]), p_ok: true });
    else if (st === "FAILED") await db.rpc("finish_cashout", { p_id: Number(m[1]), p_ok: false });
  }
  res.sendStatus(200);
});

if (process.env.AUTO_PAYOUTS === "true") setInterval(() => runPayouts().catch(e => console.error(e.message)), 60000);

app.listen(process.env.PORT || 3000, () => console.log("Kwik server running on port " + (process.env.PORT || 3000)));
