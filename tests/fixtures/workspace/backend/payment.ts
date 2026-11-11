import type { PaymentStatus } from '../shared-types/payment.js';
/** Processes payment status transitions after the payment provider webhook. */
export function processPaymentStatus(previous: PaymentStatus, event: string): PaymentStatus {
  if (event === 'payment.succeeded') return 'paid';
  if (event === 'payment.failed') return 'failed';
  return previous;
}
