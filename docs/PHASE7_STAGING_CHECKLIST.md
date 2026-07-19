# Phase 7 Staging Reliability Checklist

Run these checks with a disposable installed repository and the worker running.

1. Stop the worker after it claims a job. Wait for its lease to expire, restart a worker, and verify the job is reclaimed once rather than duplicated.
2. Simulate GitHub `429`/`503` or a temporary network failure. Verify attempts occur at approximately 30 seconds and 2 minutes, then become terminal after the third failed attempt.
3. Simulate a permanent `403`/invalid payload. Verify the job becomes terminal immediately without retrying.
4. Stop workers, push to the tracked branch, then restart them. Within the five-minute reconciler interval, verify the current `graph_snapshot` SHA matches GitHub’s live branch SHA.
5. Deliver old and new push/PR events out of order. Verify an older push is superseded and an older PR delivery does not overwrite the latest sticky comment.
6. Delete the Impact Analysis comment manually, reprocess the PR, and verify a replacement comment is created with one delivery pointer.
7. Run `pnpm reliability:status`; verify queue latency, terminal failures, and current graph rows are visible without exposing source or report bodies.
