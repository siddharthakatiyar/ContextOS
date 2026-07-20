import { findUserById } from '../models/user';

export async function getUserProfile(req: any, res: any) {
  const userId = req.user.userId;
  const user = await findUserById(userId);
  
  if (!user) {
    return res.status(404).send('User not found');
  }

  res.json({
    id: user.id,
    email: user.email,
    role: user.role
  });
}
