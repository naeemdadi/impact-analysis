We do NOT review code.

We do NOT generate code.

We do NOT replace QA.

We ONLY answer

"What should I verify before merging?"

# Final Output to User after PR

🟡 Change Impact Report

Impact Level: High

────────────────────────────────────

📍 Affected

Pages
• /checkout
• /orders/[id]
• /subscriptions

API Routes
• POST /api/checkout
• POST /api/refunds

Components
• CouponInput
• PriceSummary
• OrderSummary

Shared Modules
• CouponService
• DiscountCalculator

────────────────────────────────────

🔍 Why?

CouponService is a shared dependency.

Dependency chain:

CouponService
├── CheckoutService
│   └── /checkout
├── RefundService
│   └── POST /api/refunds
└── SubscriptionService
    └── /subscriptions

────────────────────────────────────

⚠️ Indirect Impact

These areas were not modified in this PR but depend on the changed code:

• Refunds
• Subscription Billing

────────────────────────────────────

✅ Suggested Verification

• Verify coupon application during checkout
• Verify coupon removal
• Verify price recalculation
• Verify refund calculation
• Verify subscription renewal with coupon

────────────────────────────────────

📊 Evidence

Changed Symbols
• CouponService
• calculateDiscount()

References
• 12 import references
• 5 entry points
• 3 shared services

────────────────────────────────────

Summary

This PR modifies a shared pricing service used by multiple entry points. Although only checkout files changed, refund and subscription flows also depend on the modified code.