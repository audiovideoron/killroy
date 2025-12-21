#!/usr/bin/env python3
"""
PreToolUse hook to enforce authentication on all route endpoints.
Blocks Edit/Write operations on route files if they contain unprotected endpoints.
"""

import json
import sys
import re
import os

def check_content_for_unprotected_routes(content):
    """Check if content has unprotected route decorators"""

    # Split into lines for better checking
    lines = content.split('\n')

    unprotected = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Found a route decorator
        if line.startswith('@router.') and any(method in line for method in ['get(', 'post(', 'put(', 'delete(', 'patch(']):
            # Check this line and the next 10 lines (multi-line decorator support)
            decorator_block = '\n'.join(lines[i:min(i+10, len(lines))])

            # Skip health endpoints
            if '/health' in decorator_block:
                i += 1
                continue

            # Skip capture endpoints (use API key auth instead of cookie auth)
            if '/capture' in decorator_block:
                i += 1
                continue

            # Check for auth
            has_auth = False
            if 'dependencies=' in decorator_block and 'require_auth' in decorator_block:
                has_auth = True

            if not has_auth:
                unprotected.append(line)

        i += 1

    return unprotected

def main():
    try:
        # Read hook input
        input_data = json.load(sys.stdin)

        tool_name = input_data.get("tool_name", "")
        tool_input = input_data.get("tool_input", {})

        # Only check Edit and Write tools
        if tool_name not in ["Edit", "Write"]:
            sys.exit(0)

        # Get file path
        file_path = tool_input.get("file_path", "")

        # Only check route files
        if not (file_path.endswith("routes.py") or file_path.endswith("routes/__init__.py")):
            sys.exit(0)

        # Skip auth routes (they must be public)
        if "/auth/" in file_path or file_path.endswith("auth.py"):
            sys.exit(0)

        # For Write: check the new content
        # For Edit: need to reconstruct the full file after edit
        content = None

        if tool_name == "Write":
            content = tool_input.get("content", "")
        elif tool_name == "Edit":
            # For Edit, we need to read the current file and apply the edit
            old_string = tool_input.get("old_string", "")
            new_string = tool_input.get("new_string", "")

            # Read current file
            if os.path.exists(file_path):
                with open(file_path, 'r') as f:
                    current_content = f.read()

                # Apply the edit
                content = current_content.replace(old_string, new_string, 1)
            else:
                # File doesn't exist yet, can't check
                sys.exit(0)

        if not content:
            sys.exit(0)

        # Check for unprotected routes
        unprotected = check_content_for_unprotected_routes(content)

        if unprotected:
            # Deny the operation
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"BLOCKED: Route file has {len(unprotected)} unprotected endpoint(s). All routes must have dependencies=[Depends(require_auth)] unless they are /health endpoints. First unprotected: {unprotected[0]}"
                }
            }
            print(json.dumps(output))
            sys.exit(0)

        # All routes are protected, allow
        sys.exit(0)

    except Exception as e:
        # On any error, allow the operation (fail open)
        sys.exit(0)

if __name__ == "__main__":
    main()
