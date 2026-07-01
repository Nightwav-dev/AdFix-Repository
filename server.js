require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory subscription store ─────────────────────────────────────────────
// Maps customerId -> { active: bool, subscriptionId, updatedAt }
// NOTE: This resets on server restart. For production, replace with a database
// (Postgres, MongoDB, etc). For a small user base this is fine on Render.
const subscriptionStore = new Map();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('chrome-extension://')) return callback(null, true);
    const allowed = [process.env.FRONTEND_URL, 'http://localhost:3000'];
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true,
}));

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AdFix backend running', version: '2.0.0' });
});

// ── CREATE CHECKOUT SESSION ───────────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      allow_promotion_codes: true,
      subscription_data: { metadata: { product: 'adfix_pro' } },
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[AdFix] Create checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── VERIFY CHECKOUT SESSION ───────────────────────────────────────────────────
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer'],
    });

    const active = session.payment_status === 'paid' &&
                   session.subscription?.status === 'active';

    const customerId = session.customer?.id || session.customer;

    // Store in our subscription map
    if (active && customerId) {
      subscriptionStore.set(customerId, {
        active: true,
        subscriptionId: session.subscription?.id,
        updatedAt: Date.now(),
      });
      console.log(`[AdFix] Pro activated for customer: ${customerId}`);
    }

    res.json({
      active,
      customerId,
      subscriptionId: session.subscription?.id || session.subscription,
      email: session.customer_details?.email,
    });
  } catch (err) {
    console.error('[AdFix] Verify session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CHECK SUBSCRIPTION STATUS ─────────────────────────────────────────────────
// Extension calls this on popup open to check if Pro is still active
app.get('/subscription-status', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  try {
    // Check in-memory store first (fast)
    const stored = subscriptionStore.get(customerId);

    // Always verify with Stripe directly to catch cancellations/refunds
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    const active = subscriptions.data.length > 0;
    const sub = subscriptions.data[0];

    // Update our store to match Stripe's reality
    subscriptionStore.set(customerId, {
      active,
      subscriptionId: sub?.id || null,
      updatedAt: Date.now(),
    });

    if (!active) {
      console.log(`[AdFix] Pro revoked for customer: ${customerId}`);
    }

    res.json({
      active,
      subscriptionId: sub?.id || null,
      currentPeriodEnd: sub?.current_period_end || null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end || false,
    });
  } catch (err) {
    console.error('[AdFix] Subscription status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CUSTOMER PORTAL ───────────────────────────────────────────────────────────
app.post('/customer-portal', async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.FRONTEND_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[AdFix] Customer portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[AdFix] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  switch (event.type) {

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      // Mark as active in our store
      subscriptionStore.set(obj.customer, {
        active: obj.status === 'active',
        subscriptionId: obj.id,
        updatedAt: Date.now(),
      });
      console.log(`[AdFix] Subscription ${obj.status} for: ${obj.customer}`);
      break;

    case 'customer.subscription.deleted':
      // Subscription cancelled — mark as inactive
      subscriptionStore.set(obj.customer, {
        active: false,
        subscriptionId: obj.id,
        updatedAt: Date.now(),
      });
      console.log(`[AdFix] Subscription cancelled for: ${obj.customer}`);
      break;

    case 'charge.refunded':
      // Payment refunded — find customer and mark as inactive
      try {
        const charge = await stripe.charges.retrieve(obj.id, { expand: ['customer'] });
        const customerId = charge.customer?.id || charge.customer;
        if (customerId) {
          // Cancel their subscription too
          const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
          if (subs.data.length > 0) {
            await stripe.subscriptions.cancel(subs.data[0].id);
          }
          subscriptionStore.set(customerId, { active: false, updatedAt: Date.now() });
          console.log(`[AdFix] Refund processed, Pro revoked for: ${customerId}`);
        }
      } catch (e) {
        console.error('[AdFix] Refund handling error:', e.message);
      }
      break;

    case 'invoice.payment_failed':
      // Payment failed — mark as inactive
      subscriptionStore.set(obj.customer, {
        active: false,
        subscriptionId: obj.subscription,
        updatedAt: Date.now(),
      });
      console.log(`[AdFix] Payment failed for: ${obj.customer}`);
      break;

    case 'invoice.payment_succeeded':
      // Renewal succeeded — keep active
      subscriptionStore.set(obj.customer, {
        active: true,
        subscriptionId: obj.subscription,
        updatedAt: Date.now(),
      });
      console.log(`[AdFix] Payment renewed for: ${obj.customer}`);
      break;

    default:
      console.log('[AdFix] Unhandled event:', event.type);
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`AdFix backend v2 running on port ${PORT}`);
});
