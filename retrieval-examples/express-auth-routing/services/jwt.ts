export function verifyToken(token: string): any {
  // Mock JWT verification
  if (token === 'valid-token') {
    return { userId: '123', role: 'user' };
  }
  throw new Error('Invalid token');
}

export function signToken(userId: string): string {
  // Mock JWT signing
  return `token-${userId}`;
}
