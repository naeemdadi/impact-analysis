# GitHub App Manifest and Permissions

## App Identity

- Name: `Impact Analysis`
- Homepage URL: deployment URL of the Phase 1 service
- Webhook URL: `<service-base-url>/webhooks/github`

## Webhook Events

- `installation`
- `push`
- `pull_request`

## Repository Permissions

- Metadata: Read-only
- Pull requests: Read and write
- Contents: Read-only
- Checks: Read and write

## Account Permissions

- None required for Phase 1

## Why This Is Minimum Viable

- `metadata` and `contents` support repository identity and later diff access.
- `pull_requests` is required for pull request payload, follow-up analysis, and the Phase 6 sticky PR comment.
- `checks` allows future check run status updates without re-registering app scopes.
