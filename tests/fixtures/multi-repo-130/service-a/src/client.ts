import type { Order } from '@fixture/shared';
export async function createOrder(baseUrl: string, order: Order): Promise<Order> {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order)
  });
  if (!response.ok) throw new Error('Order creation failed');
  return response.json() as Promise<Order>;
}
