export async function GET() {
  return Response.json(
    { error: "Project RAG/knowledge chunks have been removed." },
    { status: 410 }
  );
}
