export function GET() {
	return Response.json(
		{
			error: {
				code: 'not_found',
			},
		},
		{ status: 404 }
	);
}
