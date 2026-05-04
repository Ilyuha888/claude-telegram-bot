import { readdir, stat } from "fs/promises";
import { join } from "path";
import { REPOS_DIR } from "../config";
import { isPathAllowed } from "../security";

export async function listRepos(): Promise<string[]> {
  try {
    const entries = await readdir(REPOS_DIR);
    const results: string[] = [];
    for (const entry of entries) {
      const full = join(REPOS_DIR, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory() && isPathAllowed(full)) {
          results.push(entry);
        }
      } catch {
        /* skip unreadable entries */
      }
    }
    return results;
  } catch {
    return [];
  }
}
