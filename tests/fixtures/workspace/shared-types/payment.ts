/** Defines the payment status shared by the payment API and payment display. */
export type PaymentStatus = 'pending' | 'paid' | 'failed';
export interface Payment {
  id: string;
  status: PaymentStatus;
}
