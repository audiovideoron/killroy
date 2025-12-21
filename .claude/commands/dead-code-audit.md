# Dead Code Audit

Perform a comprehensive dead code analysis of the FastAgent codebase to identify unused code, imports, functions, classes, and files that can be safely removed.

## Analysis Scope

Focus on identifying:

### Python Backend Code
- **Unused imports** in all Python files
- **Unreferenced functions and methods**
- **Unused classes and class methods**
- **Dead configuration variables** in `app/config/`
- **Obsolete API endpoints** that are no longer called
- **Unused database models or repository methods**
- **Orphaned utility functions** in `app/tools/` and `app/utils/`

### Frontend JavaScript Code
- **Unused JavaScript functions** in `/static/js/`
- **Unreferenced CSS classes** in `/static/css/`
- **Dead HTML files or templates** that are no longer served
- **Unused module imports** in the modular JavaScript architecture
- **Obsolete event handlers** or DOM manipulation code

### Configuration and Data Files
- **Unused YAML configuration files** in `/config/`
- **Dead environment variables** referenced in code but not used
- **Obsolete migration files** (check if any Alembic migrations are unused)
- **Unused test files** or test utilities

### Documentation and Agent Files
- **Obsolete sub-agent files** in `.claude/agents/` that reference removed functionality
- **Dead documentation** in `/docs/` that refers to removed features
- **Unused extraction plans** in `.claude/extraction-plans/`

## Analysis Method

1. **Static Code Analysis**:
   - Use grep/ripgrep to find function definitions and their usage
   - Check import statements against actual usage
   - Identify files that are never imported or referenced

2. **API Endpoint Analysis**:
   - Cross-reference API routes with frontend JavaScript calls
   - Check if any endpoints in `app/api/routes/` are unreachable
   - Verify database repository methods are actually called

3. **Frontend Usage Analysis**:
   - Check if JavaScript functions are called from HTML or other JS files
   - Verify CSS classes are used in HTML templates
   - Identify unused shared state or service layer components

4. **Configuration Audit**:
   - Verify environment variables are actually read and used
   - Check YAML configuration keys against code that reads them
   - Identify obsolete feature flags or settings

## Focus Areas After Recent Refactoring

Given the recent preview-to-events refactoring, pay special attention to:

- **Preview-related remnants**: Any leftover preview terminology or functionality
- **Cache migration artifacts**: Old caching code that's been replaced
- **API endpoint consolidation**: Endpoints that may have been superseded
- **Frontend service layer**: Old API service methods that call removed endpoints
- **Documentation updates**: Agent files or docs referencing old architecture

## Safety Considerations

Before suggesting removal:
- **Verify with multiple search methods** (grep, ripgrep, IDE search)
- **Check for dynamic imports** or string-based references
- **Consider test code** that might reference production code
- **Look for configuration-driven usage** where code might be conditionally loaded
- **Check sub-agent files** that might reference specific functions

## Output Format

Provide results in this structure:

### High-Confidence Dead Code
Code that can be safely removed immediately:
- File paths and specific line numbers
- Reason for classification as dead code
- Estimated impact of removal

### Medium-Confidence Candidates
Code that appears unused but needs verification:
- Potential issues or edge cases to check
- Recommended verification steps

### Configuration Cleanup
- Unused environment variables
- Obsolete YAML keys
- Dead feature flags

### Documentation Cleanup
- Outdated agent files
- Obsolete documentation sections
- Unused extraction plans

## Additional Instructions

- **Cross-reference with git history** to understand when code was last modified
- **Check for commented-out code** that should be removed
- **Identify TODO comments** that reference removed functionality
- **Look for debug code** or temporary workarounds that can be cleaned up
- **Consider the hotel isolation feature** - ensure multi-tenant code isn't incorrectly flagged as unused

Focus on actionable findings that will improve code maintainability and reduce complexity in the FastAgent codebase.