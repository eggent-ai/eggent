import { NextRequest, NextResponse } from "next/server";
import { getChunksByFilename } from "@/lib/memory/memory";
import { getProject } from "@/lib/storage/project-store";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const filename = req.nextUrl.searchParams.get("filename");

    if (!filename) {
        return NextResponse.json(
            { error: "Query parameter 'filename' is required" },
            { status: 400 }
        );
    }

    const project = await getProject(id);
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    try {
        const chunks = await getChunksByFilename(id, filename);
        return NextResponse.json({ filename, chunks });
    } catch (error) {
        console.error("Error loading chunks:", error);
        return NextResponse.json(
            { error: "Failed to load chunks" },
            { status: 500 }
        );
    }
}
