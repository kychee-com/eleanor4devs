/**
 * `eleanor4devs skills list` — enumerate installed skills.
 */
import { existsSync, readdirSync } from "node:fs";

export interface ListSkillsOptions {
  targetDir: string;
}

export function listSkills(options: ListSkillsOptions): string[] {
  if (!existsSync(options.targetDir)) return [];
  return readdirSync(options.targetDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length));
}
