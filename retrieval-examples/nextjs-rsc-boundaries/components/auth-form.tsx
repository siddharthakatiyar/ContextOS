'use client';

import { authenticateUser } from '../actions/db';
import { useState } from 'react';

export function AuthForm() {
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    const success = await authenticateUser(formData);
    setLoading(false);
    if (success) alert('Welcome!');
  }

  return (
    <form action={handleSubmit}>
      <input type="email" name="email" required />
      <button disabled={loading}>Login</button>
    </form>
  );
}
