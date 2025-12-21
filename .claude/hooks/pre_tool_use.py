#!/usr/bin/env python3
# /// script
# dependencies = []
# requires-python = ">=3.8"
# ///
"""
FastAgent Pre-Tool-Use Security Hook

This hook intercepts tool calls before execution to prevent dangerous operations.
Exit code 2 blocks tool execution and shows error message to Claude.

Protected Operations:
- .env file modifications (CRITICAL - see CLAUDE.md)
- Database destruction (DROP, TRUNCATE, DELETE without WHERE)
- Recursive file deletions (rm -rf variants)
- Production source code edits (/root/fastAgent/*.py,*.ts,*.js)
- Lock file modifications (package-lock.json, uv.lock, poetry.lock)
- Dangerous git operations (push --force, reset --hard)

Rollback: Remove "hooks" section from .claude/settings.json to disable
"""

import json
import sys
import re
import os
from datetime import datetime
from pathlib import Path


def log_event(tool_name, tool_input, blocked=False, reason=""):
    """Append audit log entry to logs/pre_tool_use.json"""
    try:
        log_file = Path("logs/pre_tool_use.json")
        log_file.parent.mkdir(exist_ok=True)

        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "tool_name": tool_name,
            "tool_input": tool_input,
            "blocked": blocked,
            "reason": reason
        }

        # Append to log file (each entry on new line)
        with open(log_file, "a") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception as e:
        # Don't block on logging errors
        print(f"Warning: Failed to write audit log: {e}", file=sys.stderr)


def block_operation(message, tool_name, tool_input):
    """Block tool execution with error message"""
    log_event(tool_name, tool_input, blocked=True, reason=message)
    print(f"❌ BLOCKED: {message}", file=sys.stderr)
    sys.exit(2)  # Exit code 2 blocks tool execution


def check_env_file_protection(tool_name, tool_input):
    """
    CRITICAL: Protect .env file from ANY modifications
    Per CLAUDE.md: "ABSOLUTELY NEVER modify, edit, rewrite, or update the .env file"
    """
    if tool_name not in ["Write", "Edit"]:
        return  # Only block write operations

    file_path = tool_input.get("file_path", "")

    # Block any .env file modification (but allow .env.sample, .env.example)
    env_patterns = [
        r'/\.env$',           # Exact match: /.env
        r'\.env$',            # Ends with .env
        r'/\.env\..*$',       # .env.* variants (but not .sample/.example)
    ]

    for pattern in env_patterns:
        if re.search(pattern, file_path):
            # Allow .env.sample and .env.example
            if file_path.endswith('.env.sample') or file_path.endswith('.env.example'):
                continue

            block_operation(
                ".env file modification blocked! Per CLAUDE.md: NEVER modify .env. "
                "If changes needed, TELL the user what to change manually.",
                tool_name,
                tool_input
            )


def check_database_operations(tool_name, tool_input):
    """Protect against destructive database operations"""
    if tool_name != "Bash":
        return

    command = tool_input.get("command", "")

    dangerous_db_patterns = [
        r'\bDROP\s+DATABASE\b',
        r'\bDROP\s+TABLE\b',
        r'\bTRUNCATE\s+TABLE\b',
        r'\bDELETE\s+FROM\s+\w+\s*;',  # DELETE without WHERE clause
        r'\bDELETE\s+FROM\s+\w+\s+WHERE\s+1\s*=\s*1',  # DELETE with always-true WHERE
        r'\bmake\s+db-reset\b',  # Makefile database reset
        r'\bdocker-compose\s+down\s+.*-v',  # Docker compose with volume deletion
        r'\bdocker\s+volume\s+rm',  # Direct volume removal
    ]

    for pattern in dangerous_db_patterns:
        if re.search(pattern, command, re.IGNORECASE):
            block_operation(
                f"Destructive database operation blocked: {pattern}",
                tool_name,
                tool_input
            )


def check_recursive_deletions(tool_name, tool_input):
    """Block dangerous rm -rf commands and wildcards"""
    if tool_name != "Bash":
        return

    command = tool_input.get("command", "")

    # Check for rm -rf variants
    rm_patterns = [
        r'\brm\s+.*-[a-z]*r[a-z]*f',      # rm -rf
        r'\brm\s+.*-[a-z]*f[a-z]*r',      # rm -fr
        r'\brm\s+--recursive\s+--force',   # long form
        r'\brm\s+--force\s+--recursive',
        r'\brm\s+-r\s+.*-f',               # separate flags
        r'\brm\s+-f\s+.*-r',
    ]

    for pattern in rm_patterns:
        if re.search(pattern, command):
            # Check for dangerous paths
            dangerous_paths = [
                r'/',           # Root
                r'/\*',         # Root with wildcard
                r'~',           # Home directory
                r'\$HOME',      # Environment variable
                r'\.\.',        # Parent directory
                r'\*',          # Wildcards
                r'\.',          # Current directory
            ]

            for path_pattern in dangerous_paths:
                if re.search(path_pattern, command):
                    block_operation(
                        f"Dangerous recursive deletion blocked: rm -rf with {path_pattern}",
                        tool_name,
                        tool_input
                    )


def check_production_code_edits(tool_name, tool_input):
    """
    Block source code edits on production server
    Allows config files, logs, but blocks .py/.ts/.js/.tsx/.jsx edits
    """
    if tool_name not in ["Write", "Edit"]:
        return

    file_path = tool_input.get("file_path", "")

    # Only check production server path
    if "/root/fastAgent" not in file_path:
        return

    # Block source code extensions
    code_extensions = ['.py', '.ts', '.js', '.tsx', '.jsx', '.vue']

    for ext in code_extensions:
        if file_path.endswith(ext):
            block_operation(
                f"Production source code edit blocked: {file_path}\n"
                "Per workflow: Fix bugs on localhost → push to GitHub → deploy via Actions.\n"
                "Config files and logs are still editable on production.",
                tool_name,
                tool_input
            )


def check_lock_file_edits(tool_name, tool_input):
    """Prevent manual edits to package manager lock files"""
    if tool_name not in ["Write", "Edit"]:
        return

    file_path = tool_input.get("file_path", "")

    lock_files = [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'poetry.lock',
        'Pipfile.lock',
        'uv.lock',
        'Cargo.lock',
    ]

    for lock_file in lock_files:
        if file_path.endswith(lock_file):
            block_operation(
                f"Lock file edit blocked: {lock_file}\n"
                "Use proper package manager commands (npm install, uv sync, etc.) instead.",
                tool_name,
                tool_input
            )


def check_dangerous_git_operations(tool_name, tool_input):
    """Block dangerous git operations"""
    if tool_name != "Bash":
        return

    command = tool_input.get("command", "")

    dangerous_git_patterns = [
        (r'git\s+push\s+.*--force', "git push --force"),
        (r'git\s+push\s+.*-f\b', "git push -f"),
        (r'git\s+reset\s+--hard', "git reset --hard"),
        (r'git\s+clean\s+.*-[a-z]*f[a-z]*d', "git clean -fd"),
        (r'git\s+clean\s+.*-[a-z]*d[a-z]*f', "git clean -df"),
    ]

    for pattern, description in dangerous_git_patterns:
        if re.search(pattern, command, re.IGNORECASE):
            block_operation(
                f"Dangerous git operation blocked: {description}\n"
                "These operations can cause irreversible changes.",
                tool_name,
                tool_input
            )


def main():
    """Main hook execution"""
    try:
        # Read tool use data from stdin
        input_data = json.loads(sys.stdin.read())

        tool_name = input_data.get("tool_name", "")
        tool_input = input_data.get("tool_input", {})

        # Run all security checks
        check_env_file_protection(tool_name, tool_input)
        check_database_operations(tool_name, tool_input)
        check_recursive_deletions(tool_name, tool_input)
        check_production_code_edits(tool_name, tool_input)
        check_lock_file_edits(tool_name, tool_input)
        check_dangerous_git_operations(tool_name, tool_input)

        # If we got here, operation is safe - log and allow
        log_event(tool_name, tool_input, blocked=False, reason="")
        sys.exit(0)

    except json.JSONDecodeError as e:
        # Graceful degradation - don't block on parsing errors
        print(f"Warning: Failed to parse hook input: {e}", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        # Graceful degradation - don't block on unexpected errors
        print(f"Warning: Hook error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
