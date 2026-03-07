# Travel AI Project

## Goal
Build a travel disruption intelligence system that detects flight disruption risks, evaluates travel impact, and suggests next best actions.

## Project structure
- `apps/` > user-facing apps
- `services/` > backend services and decision logic
- `packages/` > shared types, utilities, and common modules
- `docs/` > architecture, product notes, and decisions
- `prompts/` > reusable Claude workflows
- `tasks/` > implementation plans and lessons learned

## Core engineering principles
- Simplicity first
- Minimal impact changes
- Strong typing over cleverness
- Clear boundaries between UI, business logic, and integrations
- Prefer maintainable solutions over fast hacks
- Never expose secrets or edit env files unless explicitly asked

## Planning rules
- Enter plan mode for non-trivial tasks
- For tasks involving architecture, multi-step changes, or unclear tradeoffs, inspect first and propose a plan before coding
- If implementation reveals wrong assumptions, stop and re-plan

## Execution rules
- Change only the files that are necessary
- Do not rewrite unrelated code
- For isolated low-risk fixes, implement directly
- For ambiguous or architectural changes, explain options and tradeoffs before proceeding

## Verification rules
- Do not mark work complete without verification
- Run relevant checks when available
- Sanity-check the result against the original request
- Be explicit about risks, gaps, and follow-up work

## Collaboration style
- Be concise but specific
- Explain decisions at a high level
- Ask for confirmation before major or irreversible changes
- Optimize for clean long-term structure without premature over-engineering
