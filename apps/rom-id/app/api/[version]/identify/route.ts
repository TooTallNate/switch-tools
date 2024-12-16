import { pool } from '@/db/connection';

export async function GET(request: Request) {
	const query = new URL(request.url).searchParams;
	const sha1 = query.get('sha1');
	const data = await pool.query(
		`SELECT r.*
        FROM "public"."Releases" r
        JOIN "public"."ROMs" rom
        ON r."id" = rom."releaseId"
        WHERE rom."sha1" = $1`,
		[sha1]
	);
	return Response.json(data.rows[0]);
}
