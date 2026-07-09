export async function POST() {
  return Response.json(
    { error: "RAG/knowledge ingestion has been removed. Use project files, memory.md, skills/, and pipeline artifacts instead." },
    { status: 410 }
  );
}
