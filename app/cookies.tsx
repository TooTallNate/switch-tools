import { createCookie } from '@vercel/remix';

export const sessionCookie = createCookie('__session', {
	sameSite: 'strict',
	secrets: ['s3cret1-nsp'],
	httpOnly: true,
});
