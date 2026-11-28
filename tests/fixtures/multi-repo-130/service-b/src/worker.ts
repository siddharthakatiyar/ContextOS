import { createOrder } from '@fixture/service-a/client';
import { ORDER_CREATED, type Order } from '@fixture/shared';
export const serviceAUrl = process.env.SERVICE_A_URL ?? 'http://service-a:3000';
export const queueUrl = process.env.QUEUE_URL ?? 'amqp://queue:5672';
export async function submitOrder(order: Order): Promise<Order> {
  return createOrder(serviceAUrl, order);
}
export function consumeOrders(queue: {
  subscribe(topic: string, consume: (order: Order) => void): void;
}) {
  queue.subscribe(ORDER_CREATED, (order) => console.log(order.id));
}
