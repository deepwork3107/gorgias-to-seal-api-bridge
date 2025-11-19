import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const SEAL_BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";
console.log("Seal Bridge START v3");

/** ----- Auth (Bearer) ----- */
function checkAuth(req, res, next) {
  const expected = `Bearer ${process.env.BRIDGE_BEARER}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/** ----- Helpers ----- */
async function callSeal(path, init = {}) {
  const resp = await fetch(`${SEAL_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Seal-Token": process.env.SEAL_TOKEN,
      ...(init.headers || {})
    }
  });

  const ct = resp.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await resp.json().catch(() => ({}))
    : { non_json: await resp.text().catch(() => "") };

  return { ok: resp.ok, status: resp.status, body };
}

/** Healthcheck (useful with ngrok/Render/etc.) */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** ----- GET /api/subscriptions?email=... ----- */
app.get("/api/subscriptions", checkAuth, async (req, res) => {
  try {
    const rawEmail = (req.query.email || "").toString().trim();
    if (!rawEmail) {
      return res.status(200).json({ subscriptions: [], error: { reason: "missing_email" } });
    }

    const email = encodeURIComponent(rawEmail);
    const { ok, status, body } = await callSeal(`/subscriptions?query=${email}&with-items=true`);

    if (!ok) {
      return res.status(200).json({
        subscriptions: [],
        error: { reason: "upstream_error", status, body }
      });
    }

    let list = [];
    if (Array.isArray(body?.payload)) list = body.payload;
    else if (Array.isArray(body?.subscriptions)) list = body.subscriptions;
    else if (Array.isArray(body?.payload?.subscriptions)) list = body.payload.subscriptions;

    const subs = list.map(s => ({
      id: s.id, 
      status: s.status,
      next_charge_at: s.next_billing || s.next_order_datetime || s.next_charge_at || null,
      items: (s.items || []).map(i => ({ title: i.title, qty: i.quantity ,id: i.id })),
      discounts: s.discount_codes || []
    }));

    console.log("[Seal Subscriptions Response]", JSON.stringify(subs, null, 2));

    return res.status(200).json({ subscriptions: subs });
  } catch (err) {
    return res.status(200).json({
      subscriptions: [],
      error: { reason: "bridge_exception", message: err?.message || String(err) }
    });
  }
});

/** ----- PUT /api/subscription/:id  { action: pause|resume|cancel|reactivate } ----- */
app.put("/api/subscription/:id", checkAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const action = (req.body?.action || "").toString();
    if (!id || !action) {
      return res.status(400).json({ error: "Missing id or action" });
    }

    // Correct Seal endpoint: /subscriptions/:id
    const { ok, status, body } = await callSeal(`/subscriptions/${id}`, {
      method: "PUT",
      body: JSON.stringify({ action })
    });

    if (!ok) return res.status(200).json({ error: { reason: "upstream_error", status, body } });
    return res.status(200).json(body);
  } catch (err) {
    return res.status(200).json({ error: { reason: "bridge_exception", message: err?.message || String(err) } });
  }
});

/** ----- PUT /api/subscription/:id/charge-now  { reset_schedule?: boolean } ----- */
app.put("/api/subscription/:id/charge-now", checkAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Missing id" });

    const reset = req.body?.reset_schedule ? "true" : "true"; // default true
    // Correct Seal endpoint: /subscriptions/:id/charge_now
    const { ok, status, body } = await callSeal(`/subscriptions/${id}/charge_now`, {
      method: "PUT",
      body: JSON.stringify({ reset_schedule: reset })
    });

    if (!ok) return res.status(200).json({ error: { reason: "upstream_error", status, body } });
    return res.status(200).json(body);
  } catch (err) {
    return res.status(200).json({ error: { reason: "bridge_exception", message: err?.message || String(err) } });
  }
});

/**
 * ----- PUT /api/subscription/:id/reschedule -----
 * Change next payment date/time.
 * Body: { date: "YYYY-MM-DD", time: "HH:mm", timezone: "America/Chicago", reset_schedule?: true, attempt_id?: number }
 */
app.put("/api/subscription/:id/reschedule", checkAuth, async (req, res) => {
  try {
    const subscriptionId = Number(req.params.id);
    if (!subscriptionId) return res.status(400).json({ error: "Missing subscription id" });

    const date = (req.body?.date || "").trim();      // e.g. "2025-11-10"
    const time = (req.body?.time || "").trim();      // e.g. "09:30"
    const timezone = (req.body?.timezone || "").trim(); // e.g. "America/Chicago"
    const resetSchedule = req.body?.reset_schedule ? "true" : "true"; // default true
    let attemptId = req.body?.attempt_id ? Number(req.body.attempt_id) : 0;

    if (!date || !time || !timezone) {
      return res.status(400).json({ error: "Missing date/time/timezone" });
    }

    // If no attempt id provided, fetch upcoming attempts for this subscription
    if (!attemptId) {
      const attemptsResp = await callSeal(`/subscription-billing-attempts?subscription_id=${subscriptionId}`);
      if (!attemptsResp.ok) {
        return res.status(200).json({ error: { reason: "upstream_error", status: attemptsResp.status, body: attemptsResp.body } });
      }
      const arr =
        Array.isArray(attemptsResp.body?.payload) ? attemptsResp.body.payload :
        Array.isArray(attemptsResp.body?.attempts) ? attemptsResp.body.attempts : [];
      if (arr.length > 0) {
        arr.sort((a, b) => new Date(a.date_time || a.datetime || a.scheduled_at || 0) - new Date(b.date_time || b.datetime || b.scheduled_at || 0));
        attemptId = Number(arr[0].id);
      }
    }

    if (!attemptId) {
      return res.status(200).json({
        error: { reason: "no_billing_attempt_found", message: "Could not find an upcoming billing attempt for this subscription." }
      });
    }

    // Reschedule the attempt
    const payload = {
      id: attemptId,
      subscription_id: subscriptionId,
      action: "reschedule",
      date,
      time,
      timezone,
      reset_schedule: resetSchedule
    };

    const updateResp = await callSeal(`/subscription-billing-attempt`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    if (!updateResp.ok) {
      return res.status(200).json({ error: { reason: "upstream_error", status: updateResp.status, body: updateResp.body } });
    }

    return res.status(200).json({ ok: true, billing_attempt_id: attemptId, result: updateResp.body });
  } catch (err) {
    return res.status(200).json({ error: { reason: "bridge_exception", message: err?.message || String(err) } });
  }
});

/** ----- Start server ----- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bridge running on :${PORT}`));
