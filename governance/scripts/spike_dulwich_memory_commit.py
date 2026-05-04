#!/usr/bin/env python3
"""
Spike: verify Dulwich in-memory commit without a working tree.

Exercises the full path required by dec-20260320-005 (manifest-only staging):
  1. Create a MemoryRepo (bare, no working tree)
  2. Add blobs via low-level object_store API
  3. Build nested trees from flat file paths
  4. Create commits referencing those trees
  5. Update refs/heads/main
  6. Read back and verify everything

No network, no filesystem repos — pure in-memory.
"""

from __future__ import annotations

import sys
import time
from typing import Any

from dulwich.objects import Blob, Commit, Tree
from dulwich.repo import MemoryRepo


# ---------------------------------------------------------------------------
# Helper: flat paths -> nested tree hierarchy
# ---------------------------------------------------------------------------

def build_nested_tree(
    object_store: Any,
    files: dict[str, bytes],
    file_mode: int = 0o100644,
) -> bytes:
    """
    Build a nested Git tree from a flat dict of {path: content}.

    Returns the SHA of the root tree after adding all objects to the store.

    This is the helper that dec-20260320-005 will need at runtime —
    Dulwich has no built-in "add flat paths to a bare repo" porcelain.
    """
    # Phase 1: create blobs, collect (dir_parts, filename, blob_sha)
    entries: list[tuple[tuple[str, ...], str, bytes]] = []
    for path, content in files.items():
        blob = Blob.from_string(content)
        object_store.add_object(blob)
        parts = path.split("/")
        dir_parts = tuple(parts[:-1])
        filename = parts[-1]
        entries.append((dir_parts, filename, blob.id))

    # Phase 2: group by directory, build trees bottom-up
    # Collect leaf entries per directory
    dir_entries: dict[tuple[str, ...], list[tuple[str, int, bytes]]] = {}
    for dir_parts, filename, blob_sha in entries:
        dir_entries.setdefault(dir_parts, []).append(
            (filename, file_mode, blob_sha)
        )

    # Collect all directory paths (including intermediates)
    all_dirs: set[tuple[str, ...]] = set()
    for dir_parts, _, _ in entries:
        for i in range(len(dir_parts)):
            all_dirs.add(dir_parts[: i + 1])
    # Root is always present
    all_dirs.add(())

    # Process directories deepest-first so children are built before parents
    sorted_dirs = sorted(all_dirs, key=lambda d: -len(d))
    tree_shas: dict[tuple[str, ...], bytes] = {}

    for dir_path in sorted_dirs:
        tree = Tree()
        # Add file entries in this directory
        for name, mode, sha in dir_entries.get(dir_path, []):
            tree.add(name.encode(), mode, sha)
        # Add subtree entries (children that are one level deeper)
        for child_dir, child_sha in tree_shas.items():
            if len(child_dir) == len(dir_path) + 1 and child_dir[:-1] == dir_path:
                tree.add(child_dir[-1].encode(), 0o040000, child_sha)
        object_store.add_object(tree)
        tree_shas[dir_path] = tree.id

    return tree_shas[()]


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# Spike execution
# ---------------------------------------------------------------------------

def main() -> int:
    repo = MemoryRepo.init_bare([], {})

    # -- Commit 1: initial tree with nested paths -------------------------
    print("\n=== Commit 1: initial tree ===")

    files_v1 = {
        "vault/notes/daily.md": b"# Daily note\nHello world.",
        "vault/notes/projects/alpha.md": b"# Project Alpha\nStatus: active",
        "vault/meta/index.yaml": b"version: 1\nnotes:\n  - daily.md\n",
        "README.md": b"# Test vault\n",
    }

    tree_sha = build_nested_tree(repo.object_store, files_v1)
    check(
        "root tree created",
        tree_sha is not None and len(tree_sha) == 40,
        f"sha={tree_sha.decode() if isinstance(tree_sha, bytes) else tree_sha!r}",
    )

    # Build commit
    commit1 = Commit()
    commit1.tree = tree_sha
    commit1.author = commit1.committer = b"Spike Test <spike@test.local>"
    commit1.encoding = b"UTF-8"
    commit1.message = b"feat(vault): initial manifest commit"
    now = int(time.time())
    commit1.author_time = commit1.commit_time = now
    commit1.author_timezone = commit1.commit_timezone = 0
    repo.object_store.add_object(commit1)
    repo.refs[b"refs/heads/main"] = commit1.id

    check(
        "commit 1 stored",
        repo.refs[b"refs/heads/main"] == commit1.id,
        f"sha={commit1.id.hex()}",
    )

    # Verify: read back tree and blobs
    stored_commit = repo[commit1.id]
    root_tree = repo[stored_commit.tree]

    # Walk to vault/notes/daily.md
    vault_entry = [e for e in root_tree.items() if e.path == b"vault"]
    check("root tree has 'vault' entry", len(vault_entry) == 1)

    vault_tree = repo[vault_entry[0].sha]
    notes_entry = [e for e in vault_tree.items() if e.path == b"notes"]
    check("vault/ has 'notes' subtree", len(notes_entry) == 1)

    notes_tree = repo[notes_entry[0].sha]
    daily_entry = [e for e in notes_tree.items() if e.path == b"daily.md"]
    check("vault/notes/ has 'daily.md'", len(daily_entry) == 1)

    daily_blob = repo[daily_entry[0].sha]
    check(
        "daily.md content matches",
        daily_blob.data == files_v1["vault/notes/daily.md"],
    )

    # Verify nested subdir: vault/notes/projects/alpha.md
    projects_entry = [e for e in notes_tree.items() if e.path == b"projects"]
    check("vault/notes/ has 'projects' subtree", len(projects_entry) == 1)

    projects_tree = repo[projects_entry[0].sha]
    alpha_entry = [e for e in projects_tree.items() if e.path == b"alpha.md"]
    check("vault/notes/projects/ has 'alpha.md'", len(alpha_entry) == 1)

    alpha_blob = repo[alpha_entry[0].sha]
    check(
        "alpha.md content matches",
        alpha_blob.data == files_v1["vault/notes/projects/alpha.md"],
    )

    # -- Commit 2: modify a file, add a new one --------------------------
    print("\n=== Commit 2: sequential commit on top ===")

    files_v2 = {
        "vault/notes/daily.md": b"# Daily note\nHello world.\n\n## Update\nNew entry.",
        "vault/notes/projects/alpha.md": b"# Project Alpha\nStatus: active",
        "vault/notes/projects/beta.md": b"# Project Beta\nStatus: draft",
        "vault/meta/index.yaml": b"version: 2\nnotes:\n  - daily.md\n  - projects/beta.md\n",
        "README.md": b"# Test vault\n",
    }

    tree_sha_v2 = build_nested_tree(repo.object_store, files_v2)

    commit2 = Commit()
    commit2.tree = tree_sha_v2
    commit2.parents = [commit1.id]
    commit2.author = commit2.committer = b"Spike Test <spike@test.local>"
    commit2.encoding = b"UTF-8"
    commit2.message = b"feat(vault): add beta project, update daily note"
    commit2.author_time = commit2.commit_time = now + 60
    commit2.author_timezone = commit2.commit_timezone = 0
    repo.object_store.add_object(commit2)
    repo.refs[b"refs/heads/main"] = commit2.id

    check(
        "commit 2 stored",
        repo.refs[b"refs/heads/main"] == commit2.id,
        f"sha={commit2.id.hex()}",
    )

    # Verify parent chain
    stored_c2 = repo[commit2.id]
    check(
        "commit 2 parent is commit 1",
        stored_c2.parents == [commit1.id],
    )

    # Verify new file exists
    root_v2 = repo[stored_c2.tree]
    vault_v2 = repo[[e for e in root_v2.items() if e.path == b"vault"][0].sha]
    notes_v2 = repo[[e for e in vault_v2.items() if e.path == b"notes"][0].sha]
    projects_v2 = repo[[e for e in notes_v2.items() if e.path == b"projects"][0].sha]
    beta_entries = [e for e in projects_v2.items() if e.path == b"beta.md"]
    check("beta.md exists in commit 2", len(beta_entries) == 1)

    beta_blob = repo[beta_entries[0].sha]
    check(
        "beta.md content matches",
        beta_blob.data == files_v2["vault/notes/projects/beta.md"],
    )

    # Verify updated daily.md
    daily_v2 = repo[
        [e for e in notes_v2.items() if e.path == b"daily.md"][0].sha
    ]
    check(
        "daily.md updated in commit 2",
        daily_v2.data == files_v2["vault/notes/daily.md"],
    )

    # Verify trees differ between commits
    check(
        "tree SHA changed between commits",
        tree_sha != tree_sha_v2,
        f"v1={tree_sha.hex()[:12]}… v2={tree_sha_v2.hex()[:12]}…",
    )

    # -- Verify no working tree or index was used -------------------------
    print("\n=== Invariant checks ===")
    check(
        "repo has no working directory",
        not hasattr(repo, "path") or repo.path is None
        or repo.path == repo.controldir(),
    )

    # -- Summary ----------------------------------------------------------
    print("\n" + "=" * 50)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"Results: {passed} passed, {failed} failed, {len(results)} total")

    if failed:
        print("\nFAILED checks:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}" + (f" ({detail})" if detail else ""))
        return 1

    print("\nAll checks PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
