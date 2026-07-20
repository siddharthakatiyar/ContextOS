'use server';

export async function dbConnect() {
  console.log('Connecting to database...');
  return { connected: true };
}

export async function authenticateUser(formData: FormData) {
  const email = formData.get('email');
  await dbConnect();
  if (email === 'test@test.com') return true;
  return false;
}
