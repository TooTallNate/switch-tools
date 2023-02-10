import { createCookieSessionStorage } from '@remix-run/node';

const { getSession, commitSession, destroySession } =
	createCookieSessionStorage({
		// a Cookie from `createCookie` or the CookieOptions to create one
		cookie: {
			name: '__session',
			secrets: ['s3cret1-nsp'],
		},
	});

export { getSession, commitSession, destroySession };
