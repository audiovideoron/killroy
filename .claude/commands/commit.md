---
description: "Fast commit with good message + push (CI handles security/tests)"
---

Commit current changes with a well-crafted message:

## 0. Stage Scope

- Run `git status --short` to show staged/unstaged changes
- Verify only intended changes are staged
- If nothing staged, ask user what to stage

## 1. Security Scan

- Run security-scanner agent on staged changes
- Check for: hardcoded credentials, API keys, secrets, SQL/command injection, XSS
- If CRITICAL issues found, STOP and report to user
- If warnings or clean, proceed

## 2. Commit

Write a conventional commit message:

- **Type prefix**: feat/fix/refactor/docs/test/chore/etc
- **Subject line**: Concise summary of what changed
- **Body** (multi-line):
  - What changed
  - Why it changed
  - Impact / risk assessment (if significant)
- Include Claude Code attribution footer

## 3. Push

- Always push: `git push -u origin <current-branch>`
- Do NOT ask for confirmation

---

**Note**: Tests run automatically in GitHub Actions (`tests.yml`) on push.
