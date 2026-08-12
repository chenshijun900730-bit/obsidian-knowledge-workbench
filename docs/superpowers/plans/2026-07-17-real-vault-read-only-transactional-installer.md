# Real-vault read-only transactional installer implementation plan

> Execute with test-driven development. Every production behavior starts with a focused failing test, then the smallest implementation, then the focused test again.

## Scope and stop boundary

This plan implements and commits the installer only. It does not select, open, read, install into, or test a real vault. All fixtures live under the operating-system temporary directory. Actual installation remains a later human-controlled runbook action.

## Task 1: Establish the public CLI contract

1. Add a packaging test that fails because `install:acceptance:real` and its CLI are absent.
2. Run the focused test and verify the expected RED assertion.
3. Add the minimal package script and CLI module.
4. Extend the test first for exact bounded stdin JSON, no argv/environment overrides, constant success output, allowlisted failure output, and non-disclosure of private input.
5. Implement only enough CLI parsing and error classification to pass.

## Task 2: Add fail-closed preflight

1. Add failing tests for explicit action/path validation, canonical directory checks, clean Git state, exact acceptance-artifact validation, host-running and host-unknown rejection, frozen community-plugin disablement, reserved residue, and target shape/symlink rejection.
2. Add a failing fixture that makes vault content unreadable and proves installation does not traverse it.
3. Implement `scripts/install-acceptance-real.mjs` using existing artifact leases, artifact contract validation, Git-state helpers, and safe filesystem primitives.
4. Keep all errors internally branded and expose only sanitized categories.

## Task 3: Add transactional publication and rollback

1. Add failing tests for a missing target and an existing managed target with optional `data.json`.
2. Verify the stage is same-device, private, exact, and published only by directory rename.
3. Add fault-injection tests before backup, after backup, after publish, during target validation, during rollback, and during cleanup.
4. Implement whole-directory backup, stage publication, target validation, rollback/quarantine, and owned-tree cleanup.
5. Prove classifications for `target-changed`, `rollback-incomplete`, `cleanup-incomplete`, and concurrent operations.

## Task 4: Document the supported gate

1. Update runbook and README contract tests first so they fail on the old “no supported real installer” text.
2. Document that the new entry point is preparation/install only, accepts a private explicit target, never launches or enables Obsidian, and still requires the existing fresh human authorization gates.
3. Keep paths, examples, and private evidence out of the documentation.

## Task 5: Verify and commit

1. Run focused installer, CLI, artifact, runbook, and existing synthetic-installer tests.
2. Run lint, TypeScript build, and the full test suite with the supported Node runtime.
3. Confirm the worktree contains only intended changes and no private vault path or content.
4. Confirm Graphify hooks remain installed.
5. Commit one logical conventional commit without skipping hooks.
6. Re-run status and focused verification after commit.
