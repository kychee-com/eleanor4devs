/**
 * `eleanor4devs install-skills` — copy bundled skills into the user's
 * `~/.claude/skills/eleanor4devs/` (or wherever the target dir is set).
 *
 * Each skill is shown to a `SkillReview` callback (Task 12 — skill
 * review before apply). The reviewer can accept or reject per skill;
 * rejected skills are not written. When the target already has a
 * version of the skill, the existing content is passed alongside the
 * incoming content so the reviewer can diff.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Per-skill review hook. Implementations diff the existing vs.
 * incoming markdown and return true if the new version should be
 * applied. The CLI's interactive default shows a diff and prompts;
 * tests inject a deterministic reviewer.
 */
export interface SkillReview {
  review(
    skillName: string,
    existing: string | null,
    incoming: string,
  ): Promise<boolean>;
}

/** Reviewer that accepts every change without prompting. */
export const ALWAYS_APPLY: SkillReview = {
  async review() {
    return true;
  },
};

export interface InstallSkillsOptions {
  /** Directory containing the bundled .md skill files (packaged source). */
  sourceDir: string;
  /** Where to write skills on the user's machine. */
  targetDir: string;
  /** Review hook per skill. Defaults to `ALWAYS_APPLY`. */
  review?: SkillReview;
}

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
}

export async function installSkills(
  options: InstallSkillsOptions,
): Promise<InstallSkillsResult> {
  const reviewer = options.review ?? ALWAYS_APPLY;
  const installed: string[] = [];
  const skipped: string[] = [];
  mkdirSync(options.targetDir, { recursive: true });
  const entries = readdirSync(options.sourceDir).filter((f) =>
    f.endsWith(".md"),
  );
  for (const filename of entries) {
    const skillName = filename.slice(0, -".md".length);
    const sourcePath = join(options.sourceDir, filename);
    const targetPath = join(options.targetDir, filename);
    const incoming = readFileSync(sourcePath, "utf-8");
    const existing = existsSync(targetPath)
      ? readFileSync(targetPath, "utf-8")
      : null;
    const apply = await reviewer.review(skillName, existing, incoming);
    if (!apply) {
      skipped.push(skillName);
      continue;
    }
    writeFileSync(targetPath, incoming, "utf-8");
    installed.push(skillName);
  }
  return { installed, skipped };
}
