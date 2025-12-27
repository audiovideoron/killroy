---
name: optimize-prompt
description: Transform user objective documents into Claude-optimized prompts. Apply when user provides task specifications, constraints, or pseudo-prompts that need rewriting for strict adherence.
---

# Optimize Prompt

When the user provides an objective document, constraint specification, or pseudo-prompt, transform it into a Claude-optimized format before implementation.

## When to Apply

- User provides a multi-section task specification
- User says "rewrite this prompt" or "optimize this"
- User provides constraints that must be strictly followed
- Previous implementation failed due to placeholders or partial work

## Transformation Rules

### 1. Add Authority Preamble

Every optimized prompt begins with:

```xml
<authority>
This document is authoritative.
Do not reinterpret, summarize, or relax.
Execute as specified or stop and report blockers.
</authority>
```

### 2. Add XML Structure

Wrap sections in descriptive tags for parsing priority:

```xml
<context>Why this matters</context>
<constraints>Hard rules</constraints>
<definition name="term">What it means with examples</definition>
<verification_checklist>Steps to confirm correctness</verification_checklist>
```

### 3. Reframe Negatives as Positives

| Original | Transform To |
|----------|--------------|
| "Do not use placeholders" | "All functions return valid, non-empty output" |
| "Never spawn FFmpeg" | "Only select existing artifact files" |
| "Must not exist in code" | "Remove from: code, UI, docs, tests" |

### 4. Add Concrete Definitions

When terms are abstract, define them explicitly:

```xml
<definition name="real_implementation">
A real implementation:
- Returns non-empty, functional output
- Produces measurable effect

NOT a real implementation:
- Empty string return
- TODO/placeholder comment
- Pass-through stub
</definition>
```

### 5. Include Code Examples

Show correct vs incorrect patterns:

```xml
<code_examples>
// CORRECT
function buildFilter(freq: number): string {
  return `filter=f=${freq}`;
}

// INCORRECT (implementation failure)
function buildFilter(): string {
  return ''; // TODO
}
</code_examples>
```

### 6. Add Context/Motivation

If missing, add WHY the constraints matter:

```xml
<context>
Empty returns break the pipeline and produce incorrect output.
This is unacceptable for production use.
</context>
```

### 7. Normalize Emphasis

Dial back aggressive language - Claude 4.x is highly responsive:

| Original | Transform To |
|----------|--------------|
| "CRITICAL: You MUST..." | "Always..." |
| "NEVER do X" | "Do Y instead" |
| "This is a HARD rule" | (state the rule directly) |

### 8. Add Verification Checklist

Convert verification prose into numbered steps:

```xml
<verification_checklist>
1. Enable feature X alone
2. Capture output
3. Assert output is non-empty
4. Confirm measurable effect
</verification_checklist>
```

## Output

After transforming, present the optimized prompt to the user for review before proceeding with implementation.
