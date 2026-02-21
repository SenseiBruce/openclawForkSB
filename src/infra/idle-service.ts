import type { OpenClawConfig } from "../config/types.js";

export type IdleTask = {
  name: string;
  intervalMs: number;
  execute: (config: OpenClawConfig) => Promise<string>;
};

export class IdleService {
  private tasks: IdleTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(
    private config: OpenClawConfig,
    private onTaskComplete?: (taskName: string, summary: string) => void,
  ) {}

  registerTask(task: IdleTask): void {
    this.tasks.push(task);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const task of this.tasks) {
      const timer = setInterval(async () => {
        try {
          const summary = await task.execute(this.config);
          this.onTaskComplete?.(task.name, summary);
        } catch (err) {
          this.onTaskComplete?.(task.name, `Error: ${err}`);
        }
      }, task.intervalMs);

      this.timers.set(task.name, timer);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
