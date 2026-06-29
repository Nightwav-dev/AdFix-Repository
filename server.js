require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────────────────
// Allow requests from Chrome extensions and your landing page
app.use(cors({
  origin: (origin, callback) => {
    // Allow Chrome extensions (origin is null or chrome-extension://)
    if (!origin || origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    // Allow your frontend domain
    const allowed = [process.env.FRONTEND_URL, 'http://localhost:3000'];
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true,
}));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));

// JSON body for all other routes
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AdFix backend running', version: '1.0.0' });
});

// ── CREATE CHECKOUT SESSION ───────────────────────────────────────────────────
// Called by the extension when user clicks "Upgrade to Pro"
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { product: 'adfix_pro' },
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[AdFix] Create checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── VERIFY CHECKOUT SESSION ───────────────────────────────────────────────────
// Called after user returns from Stripe with ?session_id=xxx
app.get('/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer'],
    });

    const active = session.payment_status === 'paid' &&
                   session.subscription?.status === 'active';

    res.json({
      active,
      customerId: session.customer?.id || session.customer,
      subscriptionId: session.subscription?.id || session.subscription,
      email: session.customer_details?.email,
    });
  } catch (err) {
    console.error('[AdFix] Verify session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CHECK SUBSCRIPTION STATUS ─────────────────────────────────────────────────
// Called on popup open to keep Pro status in sync
app.get('/subscription-status', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    const active = subscriptions.data.length > 0;
    const sub = subscriptions.data[0];

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
// Opens Stripe's hosted portal so users can manage/cancel their subscription
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
// Listens for subscription events from Stripe
// Set this URL in your Stripe dashboard: https://your-render-url.com/webhook
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[AdFix] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle subscription lifecycle events
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      console.log('[AdFix] Subscription active:', event.data.object.id);
      break;

    case 'customer.subscription.deleted':
      console.log('[AdFix] Subscription cancelled:', event.data.object.id);
      // In a database-backed app you'd mark the user as non-Pro here
      break;

    case 'invoice.payment_succeeded':
      console.log('[AdFix] Payment succeeded:', event.data.object.id);
      break;

    case 'invoice.payment_failed':
      console.log('[AdFix] Payment failed:', event.data.object.id);
      // Could send an email to the customer here
      break;

    default:
      console.log('[AdFix] Unhandled event:', event.type);
  }

  res.json({ received: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AdFix backend running on port ${PORT}`);
  console.log(`Stripe price ID: ${process.env.STRIPE_PRICE_ID}`);
});
