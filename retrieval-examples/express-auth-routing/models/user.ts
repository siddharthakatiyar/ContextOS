export interface User {
  id: string;
  email: string;
  role: 'admin' | 'user';
  passwordHash: string;
}

const users: Record<string, User> = {};

export async function findUserById(id: string): Promise<User | null> {
  return users[id] || null;
}
