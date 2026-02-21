import type { IdleTask } from "../idle-service.js";
import { autoDistillConversation } from "../../memory/auto-distill.js";
import fs from "node:fs/promises";
import path from "node:path";

export const memorySynthesizerTask: IdleTask = {
  name: "memory-synthesizer",
  intervalMs: 5 * 60 * 1000, // 5 minutes

  async execute(config) {
    const ragConfig = config.waterfall?.rag;
    if (!ragConfig?.enabled) {
      return "RAG disabled, skipping";
    }

    try {
      const sessionsDir = path.join(process.env.HOME || "~", ".openclaw", "sessions");
      const files = await fs.readdir(sessionsDir).catch(() => []);
      
      let processed = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        
        const sessionPath = path.join(sessionsDir, file);
        const content = await fs.readFile(sessionPath, "utf-8");
        const session = JSON.parse(content);
        
        if (!session.messages || session.messages.length < 5) continue;
        
        const transcript = session.messages
          .map((m: any) => `${m.role}: ${m.content}`)
          .join("\n");
        
        await autoDistillConversation({
          transcript,
          config,
          sessionKey: file.replace(".json", ""),
        });
        
        processed++;
      }
      
      return `Processed ${processed} sessions`;
    } catch (err) {
      return `Failed: ${err}`;
    }
  },
};
