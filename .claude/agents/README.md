# Claude Code Sub-Agents

## ⚠️ ATTENTION CLAUDE: READ THIS FIRST

**If you've been asked to create a new agent:**
1. **READ THIS ENTIRE README FIRST**
2. **USE THE META-AGENT** - Do not create agents manually
3. **Follow the command**: "Create a sub-agent for [purpose]"
4. The meta-agent will handle everything correctly

This directory contains specialized sub-agents for the FastAgent project. Sub-agents are AI assistants that handle specific tasks with custom system prompts, tools, and separate context windows.

## Critical Concept: System Prompts, Not User Prompts

**The #1 misunderstanding**: The content in agent files (`.claude/agents/*.md`) are **system prompts** that configure the sub-agent's behavior. They are NOT user prompts.

## Information Flow

```
You (User) → Primary Agent → Sub-Agent → Primary Agent → You (User)
```

**Key Points:**
- Sub-agents NEVER communicate directly with you
- Sub-agents start fresh with no conversation history  
- Sub-agents respond to the primary agent's prompt, not yours
- The `description` field tells the primary agent WHEN to use the sub-agent
- Sub-agents report results back to the primary agent only

## Agent File Structure (Proven Pattern)

Based on successful agents (api-endpoint-builder, event-cache-builder, mcp-server-scaffolder), follow this exact structure:

```yaml
---
name: agent-name            # kebab-case identifier
description: [See Trigger Keywords section for patterns]
tools: Tool1, Tool2        # Optional - inherits all if omitted
model: sonnet              # haiku | sonnet | opus (default: sonnet)
color: cyan                # Terminal color identifier
---

# Purpose

You are a [specialized role with specific expertise]. [Domain context and primary responsibility].

## Instructions

When invoked, you must follow these steps:

1. **[Action Verb + Context]:**
   - [Specific sub-task with details]
   - [Another sub-task]
   - [Edge cases to consider]

2. **[Next Major Step]:**
   - [Implementation details]
   - [What to check or verify]
   - [How to handle this step]

3. **[Continue numbered steps]:**
   - [Be specific and actionable]
   - [Reference file paths when relevant]
   - [Include error handling]

**Best Practices:**
- [ALWAYS/NEVER statements for guardrails]
- [Domain-specific best practices]
- [Performance or security considerations]
- [Testing or validation requirements]

## Report / Response

[Describe the output format]

1. **[Section Name]** - [What goes here]
2. **[Another Section]** - [Contents]
3. **[Final Section]** - [Closing information]

[Additional formatting instructions]
```

### Key Structural Patterns

1. **Purpose Section**: One paragraph, two sentences:
   - First sentence: "You are a [role]"
   - Second sentence: Expands on expertise/responsibility

2. **Instructions Section**: MUST start with "When invoked, you must follow these steps:"
   - Use numbered lists with bold headings
   - Include sub-bullets with specific details
   - Reference actual file paths and tools

3. **Best Practices**: Always include:
   - ALWAYS/NEVER directives
   - Domain-specific guidelines
   - Error handling approaches

4. **Report/Response Section**: Define exact output structure
   - Use numbered or bulleted format
   - Be explicit about what primary agent receives

## Creating New Agents

### MANDATORY: Use the Meta-Agent

**DO NOT CREATE AGENTS MANUALLY. ALWAYS USE THE META-AGENT.**

The meta-agent is the ONLY correct way to create new agents because it:
1. **Scrapes latest Claude Code documentation** ensuring current patterns
2. **Knows exact trigger words** for automatic delegation
3. **Guarantees structural consistency** across all agents
4. **Follows proven patterns** that actually work
5. **Embodies the core principle**: "Build the thing that builds the thing"

```bash
# The ONLY way to create an agent:
"Create a sub-agent for [specific purpose]"

# Claude will automatically delegate to meta-agent
# Meta-agent will:
# - Fetch docs from https://docs.anthropic.com/en/docs/claude-code/sub-agents
# - Apply ALL required patterns and keywords
# - Generate properly formatted agent file
# - Save to .claude/agents/<agent-name>.md
```

### Why Manual Creation Fails

Manual agent creation will fail because:
- You don't know the current documentation patterns
- You'll miss critical trigger words
- The structure won't match Claude Code's expectations
- The agent won't appear in available agents list
- It violates the fundamental meta-agent philosophy

### Critical: Agent Discovery Requires Restart

**IMPORTANT**: Claude Code must be restarted to discover new agents. This means:
- You get ONE SHOT to create the agent correctly
- After restart, all conversation context is lost
- The agent must be completely self-contained and perfect
- There's no opportunity to "fix and test" iteratively

This makes the meta-agent ABSOLUTELY MANDATORY because:
- It guarantees the agent works on first creation
- The agent will function without any context about its creation
- No manual fixes are possible after context loss

**Bottom Line**: If you're not using the meta-agent to create agents, you're doing it wrong. And with the restart requirement, doing it wrong means complete failure.

## Two Critical Mistakes to Avoid

1. **Misunderstanding the System Prompt** - What you write in agent files is the *system prompt*, not a user prompt. This changes how you structure instructions and what information is available to the agent.

2. **Ignoring Information Flow** - Sub-agents respond to your primary agent, not to you. Your primary agent prompts sub-agents based on your original request, and sub-agents report back to the primary agent, which then reports to you.

## Trigger Keywords for Automatic Delegation

These keywords in the `description` field enable automatic agent invocation:

### Primary Triggers (Most Powerful)
- **"proactively"** / **"PROACTIVELY"** - Enables automatic delegation
- **"MUST"** / **"MUST BE USED"** - Strong directive ensuring delegation
- **"Specialist for..."** - Defines expertise area for matching

### Secondary Triggers (Information-Dense)
- **"CRITICAL"** / **"critical"** - Emphasizes importance
- **"ALWAYS"** / **"NEVER"** - Absolute directives
- **"IMPORTANT"** - Signals high priority
- **"When invoked..."** - Clear action trigger
- **"Use this agent when/after..."** - Conditional triggers

### Description Field Best Practices

The `description` field is CRITICAL for automatic delegation. Use these patterns:

#### Pattern 1: Proactive Specialist
```yaml
description: Use proactively for [specific task]. Specialist for [domain expertise].
# Example:
description: Use proactively for creating FastAPI endpoints, API routes, request/response handling, and integrating with MCP tools for natural language query processing
```

#### Pattern 2: Conditional Use Cases
```yaml
description: Use when [condition]. Use for [specific scenarios].
# Example:
description: Use when the user asks about the codebase structure. Use for analyzing project architecture.
```

#### Pattern 3: Examples-Driven
```yaml
description: |
  Use this agent when [scenario]. Examples:
  - "specific user query"
  - "another trigger phrase"
```

## FastAgent Project Agents

### Infrastructure Agents
- **api-endpoint-builder** - Creates FastAPI routes with MCP integration
- **mcp-server-scaffolder** - Builds MCP server infrastructure  
- **mcp-client-builder** - Creates MCP client connections
- **event-cache-builder** - Implements TTL-based caching

### Analysis Agents
- **codebase-analyzer** - Analyzes project architecture
- **salesforce-monitor** - Monitors Salesforce data pipeline
- **code-quality-reviewer** - Reviews code for best practices

### Meta Agents
- **meta-agent** - Creates other agents (the "agent builder")

## Agent Capabilities

### Tool Access
- If `tools` field is omitted, agent inherits ALL available tools
- Specify tools to restrict access (security/safety)
- Common tool sets:
  - Code review: `Read, Grep, Glob`
  - Code creation: `Write, Edit, MultiEdit`
  - Debugging: `Read, Edit, Bash`
  - Research: `WebSearch, WebFetch`

### Model Selection
- **haiku** - Fast, lightweight tasks
- **sonnet** - Balanced performance (default)
- **opus** - Complex reasoning and generation

### Color Coding
Available colors: red, blue, green, yellow, purple, orange, pink, cyan
- Use consistent colors for related agents
- Helps identify agent activity in terminal

## Complex Workflows & Agent Chaining

Claude Code can intelligently chain multiple sub-agents:

```bash
# Example: Multi-stage analysis
"First use codebase-analyzer to understand the architecture, 
then use api-endpoint-builder to create a new endpoint"

# Example: Debug and review
"Use the debugger agent to fix errors, 
then have code-quality-reviewer check the changes"

# Example: Meta-generation
"Use meta-agent to create a test runner agent,
then use that new agent to run the test suite"
```

## Testing Your Agents

1. **Test in isolation first** - Invoke agent directly with specific task
2. **Test delegation** - Use trigger words to ensure automatic invocation
3. **Test chaining** - Combine with other agents for workflows
4. **Check logs** - Review agent responses in Claude's output

## Storage Hierarchy

- **Project agents**: `.claude/agents/` (higher priority, project-specific)
- **User agents**: `~/.claude/agents/` (lower priority, available globally)
- **Format**: Markdown files with YAML frontmatter

## Why This Architecture Matters

The meta-agent philosophy: "Build the thing that builds the thing"

This compound effect means:
- Rapid scaling of capabilities
- Consistent quality across agents
- Self-improving system
- Exponential productivity gains

## References

- [Claude Code Sub-Agents Documentation](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Available Tools Documentation](https://docs.anthropic.com/en/docs/claude-code/settings#tools-available-to-claude)
- Dan's Tutorial: [YouTube - My Claude Code Sub Agents BUILD THEMSELVES](https://youtu.be/7B2HJr0Y68g)