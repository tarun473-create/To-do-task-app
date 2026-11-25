import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const fail = (error: string, status = 400) => json({ error }, status);

/* Browser API calls must carry this header. Cross-site pages cannot add it without a CORS
   preflight, which this server never grants — this blocks cross-site request forgery. */
export const sameOrigin = (req: Request) => req.headers.get('x-task360') === '1';

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function errorResponse(e: unknown) {
  console.error(e);
  return fail('Something went wrong on the server. Please try again.', 500);
}
