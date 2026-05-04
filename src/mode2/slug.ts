import { randomUUID } from "crypto";

export function makeSlug(repo: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 20);
  const short = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${safeRepo}-${short}`;
}

export function tmuxNameFor(slug: string): string {
  return `work-${slug}`;
}

export function rcNameFor(slug: string): string {
  return slug;
}
