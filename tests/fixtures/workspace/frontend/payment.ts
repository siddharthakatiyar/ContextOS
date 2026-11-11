import type { PaymentStatus } from '../shared-types/payment.js';
/** Displays payment status in the checkout UI and order history. */
export function displayPaymentStatus(status: PaymentStatus): string {
  return { pending: 'Awaiting payment', paid: 'Payment received', failed: 'Payment failed' }[
    status
  ];
}
