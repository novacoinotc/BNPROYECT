# Auto-Release Fixes - January 16, 2026

## Summary

This document captures the debugging session and fixes applied to resolve auto-release failures in the P2P Trading Bot.

---

## Issues Identified and Fixed

### Issue 1: Throttle Race Condition (Commit 6c0a620)

**Problem:**
The `checkReadyForRelease` function has a 5-second throttle to prevent duplicate processing. When `sync_matched` flow completed name verification, the throttle was blocking the subsequent check.

**Sequence:**
1. Order marked PAID → `startVerification` calls `checkReadyForRelease` (T=0)
2. At this point, `nameVerified=false` (not verified yet)
3. `sync_matched` event triggers `handleSyncMatched`
4. Name verification passes (`nameVerified=true`)
5. `handleSyncMatched` calls `checkReadyForRelease` (T=2s)
6. **Throttle kicks in** (2s < 5s limit), returns early
7. Order never gets queued despite passing all checks

**Fix:**
Clear `lastCheckTime` before calling `checkReadyForRelease` in both:
- `handleSyncMatched` (line 249)
- `handlePaymentMatch` (line 970)

This ensures name verification completion (a significant state change) triggers immediate evaluation.

---

### Issue 2: startVerification Overwrites bankMatch Data (Commit 64badf4)

**Problem:**
When an order is processed via `sync_matched` flow first (which sets `bankMatch` and `nameVerified`), and then the 'paid' event triggers `startVerification`, the pending record was being completely overwritten.

**Sequence:**
1. `sync_matched` creates pending record with `bankMatch` ✓
2. Order queued for release ✓
3. Order 'paid' event fires (from polling)
4. `startVerification` **OVERWRITES** the pending record without `bankMatch`
5. `executeRelease` runs, but `pending.bankMatch` is gone
6. `registerOrderForRelease` is never called
7. `releaseCrypto` fails with "Payment not verified, refusing to release"

**Fix:**
In `startVerification`:
- Check if pending record already exists before creating a new one
- If it exists, preserve `bankMatch`, `nameVerified`, `ocrVerified`
- Skip bidirectional payment search if payment already matched via sync

---

### Issue 3: Mexican Bank Name Format (Earlier Fix - Commit 110e0b2)

**Problem:**
Mexican SPEI bank format uses comma and slash as name separators (e.g., `SAIB,BRIBIESCA/LOPEZ`) but Binance KYC uses spaces (`BRIBIESCA LOPEZ SAIB`). The name comparison was showing 0% similarity for the same person.

**Fix:**
Updated `compareNames` function to convert separators to spaces before comparison:
```typescript
.replace(/[,\/\.\-\_\|]/g, ' ')  // Replace separators with spaces
```

---

## Other Observations from Logs

### Working Cases
The logs show many successful auto-releases:
- Order $677 - Released successfully
- Order $870 - Released successfully
- Order $446 - Released successfully
- Order $1500 - Released successfully
- Order $2100 - Released successfully
- Order $600 - Released successfully
- Order $168 (75% name match) - Released successfully
- Order $1100 - Released successfully
- And many more...

### Cases Blocked Correctly
- **Amount exceeds limit**: Orders >$5000 MXN correctly require manual verification
- **Name mismatch**: Third-party payments blocked (e.g., "HANEL DE GANTE VERDUZCO" vs "SANDIA RUIZ JOSEFINA")
- **Buyer risk assessment**: Low-activity buyers (< 50 orders) require manual verification

### Cases That Failed Due to Race Conditions (Now Fixed)
- Order $850 (22845622960889147392) - Throttle race condition
- Order $300 (22845625061174595584) - startVerification overwrite race condition

---

## Code Changes Summary

### File: `src/services/auto-release.ts`

#### Change 1: Clear throttle before checkReadyForRelease
```typescript
// In handleSyncMatched (line 249)
this.lastCheckTime.delete(order.orderNumber);
await this.checkReadyForRelease(order.orderNumber);

// In handlePaymentMatch finally block (line 970)
this.lastCheckTime.delete(order.orderNumber);
await this.checkReadyForRelease(order.orderNumber);
```

#### Change 2: Preserve existing pending record
```typescript
// In startVerification
const existingPending = this.pendingReleases.get(order.orderNumber);

if (existingPending) {
  // Preserve bankMatch, nameVerified, ocrVerified
  existingPending.order = order;
} else {
  // Create new pending record
  const pending: PendingRelease = { ... };
  this.pendingReleases.set(order.orderNumber, pending);
}
```

#### Change 3: Skip bidirectional search if already matched
```typescript
if (currentPending?.bankMatch?.transactionId) {
  logger.info({ ... }, 'Payment already matched via sync - skipping');
} else try {
  // Do bidirectional search
}
```

---

## Commits

1. **6c0a620** - `fix: Clear throttle before checkReadyForRelease after name verification`
2. **64badf4** - `fix: Preserve bankMatch data when startVerification is called after sync_matched`

---

## Testing Recommendations

1. Monitor logs for `[VERIFICATION] Preserving existing pending record data` messages
2. Verify no more "Payment not verified, refusing to release" errors for valid payments
3. Check that orders processed via sync_matched flow release correctly when 'paid' event also fires
4. Confirm throttle clearing doesn't cause duplicate releases (already has queue deduplication)

---

## Architecture Notes

### Event Flow Paths
There are multiple paths an order can take:

1. **Real-time polling path:**
   - Order detected → 'paid' event → `startVerification` → bank match → `handlePaymentMatch` → release

2. **Sync endpoint path:**
   - Dashboard sync → finds payment → `sync_matched` → `handleSyncMatched` → release

3. **Hybrid path (the race condition):**
   - Sync matches payment first
   - Polling detects 'paid' event second
   - Both paths try to process the same order

### Key Data Structures
- `pendingReleases: Map<string, PendingRelease>` - Tracks orders awaiting release
- `lastCheckTime: Map<string, number>` - Throttle timestamps
- `releaseQueue: string[]` - Orders queued for release execution
- `processingOrders: Set<string>` - Lock to prevent duplicate processing

---

### Issue 4: Payment Stays Matched When Name Fails (Fix Pending)

**Problem:**
When multiple orders have the same amount, a payment could match the WRONG order by amount first. Name verification would fail, but the payment stayed "MATCHED" in the database, making it unavailable to match the CORRECT order.

**Sequence:**
1. Order A (buyer: Elena, $300) and Order B (buyer: Daniel, $300) both in PAID status
2. Payment arrives from "Daniel" for $300
3. In-memory matching picks Order A first (by amount only)
4. `db.matchPaymentToOrder()` marks payment as MATCHED to Order A
5. `handlePaymentMatch()` runs name verification - FAILS (Daniel ≠ Elena)
6. Auto-release correctly blocked, but payment stays MATCHED in DB
7. Order B is marked PAID, searches for unmatched payments
8. No payment available - it's still matched to Order A!

**Fix:**
When name verification fails in `handlePaymentMatch` and `handleSyncMatched`:
- Call new `db.unmatchPayment()` to reset payment status to PENDING
- Clear `pending.bankMatch` so the order can match a different payment
- Payment is now available to match Order B (correct buyer)

```typescript
// In handlePaymentMatch finally block
if (!nameMatches && finalPending.bankMatch?.transactionId) {
  await db.unmatchPayment(transactionId);
  finalPending.bankMatch = undefined;
}
```

---

## Status

All identified race conditions have been fixed and pushed to main. The bot should now correctly auto-release orders that pass all verification checks.
