import { createCookieSessionStorage } from '@vercel/remix';
import { sessionCookie } from './cookies';

const { getSession, commitSession, destroySession } =
	createCookieSessionStorage({
		cookie: sessionCookie,
	});

export { getSession, commitSession, destroySession };
