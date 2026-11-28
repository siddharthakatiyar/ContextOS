import { ORDER_CREATED, type Order } from '@fixture/shared';
export const resources = {
  postgres: process.env.DATABASE_URL,
  redis: process.env.REDIS_URL,
  queue: process.env.QUEUE_URL
};
interface Clients {
  postgres: { query(sql: string, values: string[]): Promise<void> };
  redis: { set(key: string, value: string): Promise<void> };
  queue: { publish(topic: string, order: Order): Promise<void> };
}
/** POST /orders implements createOrder from openapi.yaml. */
export async function handleCreateOrder(order: Order, clients: Clients): Promise<Order> {
  await clients.postgres.query('INSERT INTO orders(id) VALUES ($1)', [order.id]);
  await clients.redis.set(`order:${order.id}`, JSON.stringify(order));
  await clients.queue.publish(ORDER_CREATED, order);
  return order;
}
