---
name: pull-request-review
description: Review a proposed code change for defects, regressions, missing tests, and merge risks. Use before a human reviews or merges a pull request.
---

# Pull Request Review

- Read the task brief and relevant decision records first.
- Inspect the complete diff, not only the changed lines.
- Prioritize concrete correctness and security findings over style preferences.
- Include file and line references and explain impact and reproduction conditions.
- Check tests, error handling, concurrency, data migrations, and compatibility.
- Report findings first, then testing gaps and residual risks. Do not modify the author worktree.
