# AdFix Backend

Node.js/Express server handling Stripe subscriptions for AdFix Pro ($1.99/month).

---

## Setup Instructions

### Step 1 — Create a Stripe Account

1. Go to [stripe.com](https://stripe.com) and sign up
2. Complete identity verification (required to receive payouts)
3. In the Stripe Dashboard, make sure you're in **Test mode** first (toggle in top-left)

### Step 2 — Create Your Product & Price

1. Go to **Products** → **Add Product**
2. Name it `AdFix Pro`
3. Set pricing: **$1.99** → **Recurring** → **Monthly**
4. Click **Save product**
5. Copy the **Price ID** — looks like `price_1Abc123...`

### Step 3 — Get Your API Keys

Go to **Developers** → **API Keys**:
- Copy your **Publishable key** (`pk_test_...` for test, `pk_live_...` for live)
- Copy your **Secret key** (`sk_test_...` for test, `sk_live_...` for live)

### Step 4 — Deploy to Render

1. Push this `adfix-backend` folder to a GitHub repo
2. Go to [render.com](https://render.com) and sign up
3. Click **New** → **Web Service**
4. Connect your GitHub repo
5. Set these fields:
   - **Name**: `adfix-backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
6. Click **Advanced** → **Add Environment Variables**:

| Key | Value |
|-----|-------|
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` |
| `STRIPE_PRICE_ID` | `price_...` |
| `STRIPE_WEBHOOK_SECRET` | (set after next step) |
| `FRONTEND_URL` | your landing page URL |

7. Click **Deploy**
8. Copy your Render URL: `https://adfix-backend.onrender.com`

### Step 5 — Set Up Stripe Webhook

1. In Stripe Dashboard → **Developers** → **Webhooks**
2. Click **Add endpoint**
3. Set URL to: `https://your-render-url.onrender.com/webhook`
4. Select events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Click **Add endpoint**
6. Copy the **Signing secret** (`whsec_...`)
7. Add it as `STRIPE_WEBHOOK_SECRET` in Render environment variables

### Step 6 — Update the Extension

Open `adfix/src/stripe.js` and update:

```javascript
const ADFIX_CONFIG = {
  backendUrl: 'https://your-render-url.onrender.com',
  stripePublishableKey: 'pk_live_YOUR_KEY',
  priceId: 'price_YOUR_PRICE_ID',
};
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| POST | `/create-checkout-session` | Start Stripe Checkout |
| GET | `/verify-session?session_id=xxx` | Verify completed payment |
| GET | `/subscription-status?customerId=xxx` | Check if Pro is active |
| POST | `/customer-portal` | Open billing management |
| POST | `/webhook` | Stripe webhook receiver |

---

## Testing with Stripe Test Mode

Use test card `4242 4242 4242 4242` with any future expiry and any CVC.

Switch to **Live mode** in both Stripe and your `.env` when ready to accept real payments.
