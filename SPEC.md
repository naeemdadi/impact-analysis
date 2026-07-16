# Inputs

## Git
- Changed files
- Changed lines

## Symbols
- Changed functions
- Changed classes
- Changed React components

## Affected
- Pages
- API Routes
- Components
- Shared Modules

## Relationships
- Imports
- Callers
- Callees

## Output

### Impact Level
Rules:
- Shared module changed → High
- Route component changed → Medium
- Local component only → Low

### Affected
List of pages, APIs, components and shared modules.

### Why
Generate dependency chain from changed symbol.

### Indirect Impact
Find routes/APIs that depend on changed shared modules but were not modified.

### Suggested Verification
LLM generates from structured evidence only.

### Evidence
- Changed symbols
- Import count
- Entry point count
- Dependency chain