import { requireAuth } from './middleware/auth';
import { getUserProfile } from './controllers/user';

export function setupRoutes(app: any) {
  // Public route
  app.get('/api/health', (req: any, res: any) => res.send('OK'));

  // Protected route
  app.get('/api/users/profile', requireAuth, getUserProfile);
}
