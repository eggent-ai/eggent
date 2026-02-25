
/**
 * Interface for text splitter options
 */
export interface TextSplitterOptions {
    chunkSize: number;
    chunkOverlap: number;
    separators?: string[];
    keepSeparator?: boolean;
}

/**
 * Splits text into chunks recursively trying different separators
 * to find the best split points.
 */
export class RecursiveCharacterTextSplitter {
    private chunkSize: number;
    private chunkOverlap: number;
    private separators: string[];
    private keepSeparator: boolean;

    constructor(options: Partial<TextSplitterOptions> = {}) {
        this.chunkSize = options.chunkSize ?? 400;
        this.chunkOverlap = options.chunkOverlap ?? 80;
        this.separators = options.separators ?? ["\n\n", "\n", " ", ""];
        this.keepSeparator = options.keepSeparator ?? false;
    }

    /**
     * Split text into chunks
     */
    async splitText(text: string): Promise<string[]> {
        const finalChunks: string[] = [];
        let separator = "";

        // Find the appropriate separator
        for (const s of this.separators) {
            if (s === "") {
                separator = s;
                break;
            }
            if (text.includes(s)) {
                separator = s;
                break;
            }
        }

        // Process splits
        const splits: string[] = separator
            ? text.split(separator)
            : text.split(""); // Character split if empty separator

        // Reassemble into valid chunks
        let currentChunk: string[] = [];
        let currentLength = 0;

        for (const split of splits) {
            const splitLen = split.length;
            const sepLen = this.keepSeparator ? separator.length : 0;

            if (currentLength + splitLen + sepLen > this.chunkSize) {
                if (currentLength > 0) {
                    const joined = currentChunk.join(separator);
                    finalChunks.push(joined);

                    // Handle overlap
                    // This is a simplified overlap implementation 
                    // Ideally we'd keep enough previous chunks to satisfy overlap
                    while (
                        currentLength > this.chunkOverlap &&
                        currentChunk.length > 0
                    ) {
                        const removed = currentChunk.shift();
                        currentLength -= (removed?.length ?? 0) + (currentChunk.length > 0 ? sepLen : 0);
                    }
                }
            }

            currentChunk.push(split);
            currentLength += splitLen + (currentChunk.length > 1 ? sepLen : 0);
        }

        // Add remaining chunk
        if (currentChunk.length > 0) {
            finalChunks.push(currentChunk.join(separator));
        }

        return finalChunks;
    }

    /**
     * Split documents (implemented just for interface compatibility if needed later)
     */
    async createDocuments(texts: string[]): Promise<string[]> {
        const docs: string[] = [];
        for (const text of texts) {
            docs.push(...(await this.splitText(text)));
        }
        return docs;
    }
}
