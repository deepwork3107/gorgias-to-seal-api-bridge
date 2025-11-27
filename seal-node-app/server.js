import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const SEAL_BASE = "https://app.sealsubscriptions.com/shopify/merchant/api";

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
  const fullUrl = `${SEAL_BASE}${path}`;

  const resp = await fetch(fullUrl, {
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

/** Healthcheck */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** ----- GET /api/subscriptions?email=... ----- */
app.get("/api/subscriptions", checkAuth, async (req, res) => {
  try {
    const rawEmail = (req.query.email || "").toString().trim();
    if (!rawEmail) {
      return res.status(200).json({ subscriptions: [], error: { reason: "missing_email" } });
    }

    const email = encodeURIComponent(rawEmail);
    const { ok, status, body } = await callSeal(`/subscriptions?query=${email}&with-items=true&with-billing-attempts=true`);

    if (!ok) {
      return res.status(200).json({
        subscriptions: [],
        error: { reason: "upstream_error", status, body }
      });
    }

    let list = [];
    if (Array.isArray(body?.payload?.subscriptions)) list = body.payload.subscriptions;
    else if (Array.isArray(body?.subscriptions)) list = body.subscriptions;
    else if (Array.isArray(body?.payload)) list = body.payload;

    const subs = list.map(s => {
      const billingAttempts = (s.billing_attempts || []).map(ba => ({
        id: ba.id,
        date: ba.date || ba.date_time || ba.datetime || ba.scheduled_at || null,
        status: ba.status || null,
        order_id: ba.order_id || null,
        completed_at: ba.completed_at || null
      }));

      let nextBillingAttempt = null;
      const now = new Date();
      
      const upcomingAttempts = billingAttempts.filter(ba => {
        const status = (ba.status || "").toLowerCase().trim();
        const attemptDate = ba.date ? new Date(ba.date) : null;
        const isPending = !status || status === "pending" || status === "";
        const isFuture = attemptDate && attemptDate > now;
        return isPending || isFuture;
      });

      if (upcomingAttempts.length > 0) {
        upcomingAttempts.sort((a, b) => {
          const dateA = a.date ? new Date(a.date) : new Date(0);
          const dateB = b.date ? new Date(b.date) : new Date(0);
          return dateA - dateB;
        });
        
        nextBillingAttempt = {
          id: upcomingAttempts[0].id,
          date: upcomingAttempts[0].date,
          status: upcomingAttempts[0].status || "pending"
        };
      }

      return {
        id: s.id, 
        subscription_id: s.id,
        status: s.status,
        items: (s.items || []).map(i => ({ title: i.title, qty: i.quantity, id: i.id })),
        discounts: s.discount_codes || [],
        billing_attempts: billingAttempts,
        next_billing_attempt: nextBillingAttempt, // Use next_billing_attempt.id for skip action body
        next_billing_attempt_id: nextBillingAttempt ? nextBillingAttempt.id : null
      };
    });

    return res.status(200).json({ subscriptions: subs });
  } catch (err) {
    return res.status(200).json({
      subscriptions: [],
      error: { reason: "bridge_exception", message: err?.message || String(err) }
    });
  }
});

/** ----- PUT /api/subscription/:subscriptionId/skip/:attemptId -----
 * Skip a specific billing attempt for the subscription.
 */
app.put("/api/subscription/:subscriptionId/skip/:attemptId", checkAuth, async (req, res) => {
  try {
    const subscriptionId = Number(req.params.subscriptionId);
    const billingAttemptId = Number(req.params.attemptId);

    if (!subscriptionId || Number.isNaN(subscriptionId)) {
      return res.status(400).json({ error: "Invalid subscription_id in URL" });
    }

    if (!billingAttemptId || Number.isNaN(billingAttemptId)) {
      return res.status(400).json({ error: "Invalid billing_attempt_id in URL" });
    }

    const payload = {
      id: billingAttemptId,
      subscription_id: subscriptionId,
      action
    };

    const updateResp = await callSeal(`/subscription-billing-attempt`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });

    if (!updateResp.ok) {
      return res.status(200).json({
        error: {
          reason: "upstream_error",
          status: updateResp.status,
          body: updateResp.body
        }
      });
    }

    return res.status(200).json({
      ok: true,
      subscription_id: subscriptionId,
      billing_attempt_id: billingAttemptId,
      result: updateResp.body
    });
  } catch (err) {
    return res.status(200).json({
      error: { reason: "bridge_exception", message: err?.message || String(err) }
    });
  }
});

/** ----- PUT /api/subscription/:id  { action: pause|resume|cancel|reactivate } ----- */
app.put("/api/subscription/:id", checkAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const action = (req.body?.action || "").toString().toLowerCase();
    
    if (!id || !action) {
      return res.status(400).json({ error: "Missing id or action" });
    }

    if (!["pause", "resume", "cancel", "reactivate"].includes(action)) {
      return res.status(400).json({ error: "Invalid action. Must be: pause, resume, cancel, or reactivate" });
    }

    const { ok, status, body } = await callSeal(`/subscription`, {
      method: "PUT",
      body: JSON.stringify({ id, action })
    });

    if (!ok) {
      return res.status(200).json({ 
        error: { 
          reason: "upstream_error", 
          status, 
          body,
          attempted_endpoint: `${SEAL_BASE}/subscription`,
          request_payload: { id, action }
        } 
      });
    }
    
    return res.status(200).json(body);
  } catch (err) {
    return res.status(200).json({ error: { reason: "bridge_exception", message: err?.message || String(err) } });
  }
});

/** ----- Start server ----- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {});
