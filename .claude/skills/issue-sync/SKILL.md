---
name: issue-sync
description: Sync GitHub issues to local workspace as editable files. Use this when user wants to work on, edit, view, or discuss a GitHub issue locally. Automatically pulls issue content to appropriate local file path, allows editing, and syncs changes back.
---

# Issue Sync Skill

This skill treats GitHub issues as cloud storage for working documents, keeping the local filesystem clean while enabling local editing and collaboration.

## When to Use This Skill

Invoke this skill when the user:
- Says "work on issue #47"
- Says "pull issue #47"
- Wants to edit a GitHub issue locally
- References an issue they want to discuss or modify
- Needs to run commands on issue content (like `/architecture`)

## Workflow

### 1. Pull Issue to Local File

When user wants to work on an issue:

```bash
# Get issue body content
gh issue view ISSUE_NUMBER --json body -q .body > LOCAL_FILE_PATH
```

**File Path Mapping:**
- Default path: `issues/ISSUE_NUMBER.md` (working directory, gitignored)
- This keeps all issue work in one ephemeral location
- User can request different path if needed

**After pulling:**
- Tell user: "Pulled issue #NUMBER to LOCAL_FILE_PATH. You can now edit it locally."
- The file is now available for reading, editing, and discussion

### 2. Work Locally

While the file exists:
- User and Claude can read, edit, and discuss the file normally
- Run commands like `/architecture docs/pwa/plan.md`
- Make changes using Edit, Write tools
- Full local file system capabilities

### 3. Push Changes Back to Issue

When user is done or asks to sync:

```bash
# Update issue body with local file content
gh issue edit ISSUE_NUMBER --body-file LOCAL_FILE_PATH
```

Tell user: "Synced LOCAL_FILE_PATH back to issue #NUMBER"

### 4. Clean Up (Optional)

When user is done with the issue:

```bash
rm LOCAL_FILE_PATH
```

Tell user: "Deleted LOCAL_FILE_PATH. Issue #NUMBER remains in cloud."

## File Path Guidelines

**Default pattern: `issues/NUMBER.md`**
- All issues go to `issues/` working directory by default
- Example: Issue #47 → `issues/47.md`
- Directory is gitignored (ephemeral working space)
- Clean, consistent, predictable

**Custom paths:**
- User can request different path if needed
- Example: "Pull issue #47 to docs/pwa/plan.md"

## Examples

### Example 1: Work on Feature Issue

User: "I want to work on issue #47"

Claude:
1. Creates issues directory if needed: `mkdir -p issues`
2. Runs: `gh issue view 47 --json body -q .body > issues/47.md`
3. Says: "Pulled issue #47 to issues/47.md. Ready to work on it."

User makes edits, discusses with Claude...

User: "Push my changes back"

Claude:
1. Runs: `gh issue edit 47 --body-file issues/47.md`
2. Says: "Synced changes to issue #47"

User: "Clean up the file"

Claude:
1. Runs: `rm issues/47.md`
2. Says: "Deleted local file. Issue #47 remains in GitHub."

### Example 2: Run Architecture Command

User: "Work on issue #47 and run the architecture command"

Claude:
1. Runs: `mkdir -p issues && gh issue view 47 --json body -q .body > issues/47.md`
2. Says: "Pulled issue #47 to issues/47.md"
3. Runs: `/architecture issues/47.md`
4. Architecture command validates and fixes issues/47.md
5. Runs: `gh issue edit 47 --body-file issues/47.md`
6. Says: "Synced corrected plan back to issue #47"
7. Runs: `rm issues/47.md`
8. Says: "Cleaned up. Corrected plan is in GitHub."

## Key Principles

1. **Issues are cloud storage** - permanent, searchable, trackable
2. **Local files are temporary** - working copies only
3. **Clean filesystem** - delete local files when done
4. **User control** - always ask about paths if unclear
5. **Sync both ways** - pull to edit, push to save

## Error Handling

If `gh` command fails:
- Check if user is authenticated: `gh auth status`
- Check if issue exists: `gh issue view NUMBER`
- Provide clear error messages

If file path conflicts:
- Ask user if they want to overwrite
- Or suggest alternate path

## Notes

- This skill works with the existing `gh` CLI tool
- Requires GitHub authentication (usually already set up)
- Can be used multiple times per session
- Files can be synced multiple times (edit locally, push, edit more, push again)
