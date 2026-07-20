import { ReactNode } from 'react';
import { getSession } from '../lib/session';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  
  return (
    <html lang="en">
      <body>
        <nav>
          {session ? `Logged in as ${session.user.name}` : 'Guest'}
        </nav>
        {children}
      </body>
    </html>
  );
}
