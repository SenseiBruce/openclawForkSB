import * as lancedb from "@lancedb/lancedb";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/vector-store");

export type MemoryMetadata = {
  category?: string;
  timestamp: number;
  [key: string]: any;
};

export type MemoryEntry = {
  vector: number[];
  text: string;
  metadata: string;
  created_at: number;
  last_accessed: number;
  access_count: number;
  memory_tier: "hot" | "consolidated" | "archived";
};

export class VectorStoreService {
  private static instance: VectorStoreService;
  private db?: lancedb.Connection;
  private table?: lancedb.Table;
  private dbPath: string;
  private embeddingModel: string;
  private localUrl: string;

  private constructor(config: { dbPath: string; embeddingModel: string; localUrl: string }) {
    this.dbPath = config.dbPath;
    this.embeddingModel = config.embeddingModel;
    this.localUrl = config.localUrl.replace("/v1", "");
  }

  public static getInstance(config?: {
    dbPath: string;
    embeddingModel: string;
    localUrl: string;
  }): VectorStoreService {
    if (!VectorStoreService.instance) {
      if (!config) {
        throw new Error("VectorStoreService must be initialized with config first");
      }
      VectorStoreService.instance = new VectorStoreService(config);
    }
    return VectorStoreService.instance;
  }

  public async initialize(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });

      this.db = await lancedb.connect(this.dbPath);
      const tableNames = await this.db.tableNames();

      if (tableNames.includes("memories")) {
        this.table = await this.db.openTable("memories");
      } else {
        const dummyEmbedding = await this.getEmbedding("initialization");
        const now = Date.now();
        this.table = await this.db.createTable("memories", [
          {
            vector: dummyEmbedding,
            text: "initialization",
            metadata: JSON.stringify({ category: "system", timestamp: now }),
            created_at: now,
            last_accessed: now,
            access_count: 1,
            memory_tier: "hot",
          },
        ]);
      }
      log.info(`LanceDB initialized at ${this.dbPath}`);
    } catch (err) {
      log.error(`Failed to initialize LanceDB: ${err}`);
      throw err;
    }
  }

  public async getEmbedding(text: string): Promise<number[]> {
    try {
      const response = await fetch(`${this.localUrl}/api/embeddings`, {
        method: "POST",
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { embedding: number[] };
      return data.embedding;
    } catch (err) {
      log.error(`Embedding failed for text: "${text.slice(0, 50)}...": ${err}`);
      throw err;
    }
  }

  public async saveMemory(text: string, metadata: object): Promise<void> {
    await this.initialize();
    if (!this.table) {
      throw new Error("Vector table not initialized");
    }

    const chunks = this.chunkText(text, 500);
    const now = Date.now();

    for (const chunk of chunks) {
      const embedding = await this.getEmbedding(chunk);
      await this.table.add([
        {
          vector: embedding,
          text: chunk,
          metadata: JSON.stringify({
            ...metadata,
            timestamp: now,
          }),
          created_at: now,
          last_accessed: now,
          access_count: 0,
          memory_tier: "hot",
        },
      ]);
    }
    log.info(`Saved memory chunk(s) for: "${text.slice(0, 50)}..."`);
  }

  public async queryMemory(query: string, limit: number = 3): Promise<any[]> {
    await this.initialize();
    if (!this.table) {
      throw new Error("Vector table not initialized");
    }

    const embedding = await this.getEmbedding(query);
    const results = await this.table.vectorSearch(embedding).limit(limit).toArray();

    this.trackAccess(results).catch((err) => log.error(`Failed to track memory access: ${err}`));

    return results.map((r) => ({
      text: r.text,
      metadata: JSON.parse(r.metadata as string),
      score: (r as any)._distance,
      last_accessed: r.last_accessed ?? Date.now(),
      access_count: r.access_count ?? 0,
      memory_tier: r.memory_tier ?? "hot",
    }));
  }

  private async trackAccess(results: any[]): Promise<void> {
    if (!this.table || results.length === 0) {
      return;
    }

    const now = Date.now();
    for (const res of results) {
      const count = Number(res.access_count ?? 0);
      const updateData = {
        last_accessed: now,
        access_count: count + 1,
      };

      try {
        await (this.table as any).update(updateData, {
          where: `text = '${res.text.replace(/'/g, "''")}'`,
        });
      } catch (err) {
        log.warn(`Could not update access stats for memory chunk: ${err}`);
      }
    }
  }

  private chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  }
}
