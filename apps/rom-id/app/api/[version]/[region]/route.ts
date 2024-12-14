import { notFound } from 'next/navigation';
import { pool } from '@/db/connection';
import type { NextRequest } from 'next/server';

interface Params {
    region: string;
}

async function getRegionId(region: string): Promise<number | null> {
    const result = await pool.query(
        `(
            SELECT "Regions"."id"
            FROM "public"."Regions"
            WHERE LOWER("name") = (LOWER($1))
        )
        UNION
        (
            SELECT "RegionAliases"."regionId"
            FROM "public"."RegionAliases"
            WHERE LOWER("alias") = (LOWER($1))
        )
        LIMIT 1`
        , [region]);
    if (result.rows.length === 1) {
        return result.rows[0].id;
    }
    return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<Params> }) {
    const { region } = await params;
    const regionId = await getRegionId(region);
    if (regionId === null) {
        throw notFound();
    }
    const data = await pool.query(
        `SELECT 
            r.*, 
            COALESCE(ARRAY_AGG(ra."alias"), '{}') AS "aliases"
        FROM 
            "public"."Regions" r
        LEFT JOIN 
            "public"."RegionAliases" ra
        ON 
            r."id" = ra."regionId"
        WHERE 
            r."id" = $1
        GROUP BY 
            r."id"`
        , [regionId]);
    const regionDoc = data.rows[0];
    if (!regionDoc) {
        throw notFound();
    }
    return Response.json(regionDoc);
}
