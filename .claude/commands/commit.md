---
description: "Fast commit with good message + push (CI handles security/tests)"
---

Commit current changes with a well-crafted message:

## 0. Stage Scope

- Run `git status --short` to show staged/unstaged changes
- Verify only intended changes are staged
- If nothing staged, ask user what to stage

## 1. Commit

Write a conventional commit message:

- **Type prefix**: feat/fix/refactor/docs/test/chore/etc
- **Subject line**: Concise summary of what changed
- **Body** (multi-line):
  - What changed
  - Why it changed
  - Impact / risk assessment (if significant)
- Include Claude Code attribution footer

## 2. Push

- Always push: `git push -u origin <current-branch>`
- Do NOT ask for confirmation

---

**Note**: Security scanning and tests run automatically in GitHub Actions:
- `security-scan.yml` - Scans for vulnerabilities on PRs
- `tests.yml` - Runs smoke tests on PRs
- `code-quality.yml` - Weekly code analysis, files beads

Check GitHub Actions tab for results after push.
