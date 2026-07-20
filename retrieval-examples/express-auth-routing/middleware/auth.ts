import { verifyToken } from '../services/jwt';

export function requireAuth(req: any, res: any, next: Function) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send('Missing authorization header');
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).send('Invalid token');
  }
}
