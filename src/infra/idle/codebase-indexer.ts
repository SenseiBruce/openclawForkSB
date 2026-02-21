import type { IdleTask } from "../idle-service.js";
import { VectorStoreService } from "../../memory/VectorStoreService.js";
import fs from "node:fs/promises";
import path from "node:path";

const CODE_EXTENSIONS = [".ts", ".js", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h"];

export const codebaseIndexerTask: IdleTask = {
  name: "codebase-indexer",
  intervalMs: 15 * 60 * 1000, // 15 minutes

  async execute(config) {
    const ragConfig = config.waterfall?.rag;
    if (!ragConfig?.enabled) {
      return "RAG disabled, skipping";
    }

    try {
      const workspaceDir = path.join(process.env.HOME || "~", ".openclaw", "workspace");
      const exists = await fs.access(workspaceDir).then(() => true).catch(() => false);
      
      if (!exists) {
        return "No workspace directory";
      }

      const vectorStore = VectorStoreService.getInstance({
        dbPath: ragConfig.dbPath || "./data/memory.lance",
        embeddingModel: ragConfig.embeddingModel || "nomic-embed-text",
        localUrl: config.waterfall?.localUrl || "http://localhost:11434/v1",
      });

      let indexed = 0;
      const files = await fs.readdir(workspaceDir, { recursive: true });
      
      for (const file of files) {
        const filePath = path.join(workspaceDir, file.toString());
        const ext = path.extname(filePath);
        
        if (!CODE_EXTENSIONS.includes(ext)) continue;
        
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile() || stat.size > 100000) continue;
        
        const content = await fs.readFile(filePath, "utf-8").catch(() => null);
        if (!content) continue;
        
        await vectorStore.saveMemory(content.slice(0, 2000), {
          category: "codebase",
          file: file.toString(),
          extension: ext,
        });
        
        indexed++;
      }
      
      return `Indexed ${indexed} files`;
    } catch (err) {
      return `Failed: ${err}`;
    }
  },
};
