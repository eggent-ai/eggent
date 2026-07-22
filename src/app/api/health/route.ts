export async function GET() {
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.2.0",
  });
}
