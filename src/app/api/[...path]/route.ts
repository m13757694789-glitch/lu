// SQLite stays out of cloud function startup (Node 20 lacks node:sqlite).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
async function handle(request: Request) {
  const { handleRequest } = await import("@/lib/api-router");
  return handleRequest(request);
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
