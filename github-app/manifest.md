# GitHub App Manifest and Permissions

## App Identity

- Name: `Impact Analysis`
- Homepage URL: public project or demo page
- Webhook URL: `<service-base-url>/webhooks/github`

## Webhook Events

- `installation`
- `installation_repositories`
- `push`
- `pull_request`

## Repository Permissions

- Metadata: Read-only
- Pull requests: Read and write
- Contents: Read-only

## Account Permissions

- None required

## Why This Is Minimum Viable

- `metadata` and `contents` support repository identity and source retrieval.
- `pull_requests` is required for pull request payload, follow-up analysis, and the Phase 6 sticky PR comment.
