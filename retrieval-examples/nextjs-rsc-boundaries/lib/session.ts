import { dbConnect } from '../actions/db';

export async function getSession() {
  const db = await dbConnect();
  // Mock session lookup
  return { user: { id: '1', name: 'Alice' } };
}
