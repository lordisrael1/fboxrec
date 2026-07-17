# ADR 017: AWS IAM Role Failure — Dynamic Credential Fetching (IMDSv2)

## Problem

The hand-rolled SigV4 S3 client (§6 of the Bible) only reads static
`FLIGHTBOX_S3_KEY` / `FLIGHTBOX_S3_SECRET`. Secure AWS deployments (ECS/
Fargate, EC2 instance roles) prohibit static keys: credentials are temporary
IAM role credentials fetched from local metadata endpoints and rotate
hourly. Without them, the S3 sink is dead on arrival exactly where the
platform playbook (§5) sends people.

## Decision

The zero-dependency S3 client implements a minimal **credential provider
chain**, resolved in order and cached until ~5 minutes before expiry:

1. Explicit config / `FLIGHTBOX_S3_KEY`+`SECRET` (+ optional session token)
2. Standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
   `AWS_SESSION_TOKEN` env vars
3. **ECS/Fargate task role** — GET
   `http://169.254.170.2${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`
4. **EC2 instance role via IMDSv2** — PUT `/latest/api/token`
   (X-aws-ec2-metadata-token-ttl-seconds) then GET
   `/latest/meta-data/iam/security-credentials/<role>` with the token.
   IMDSv2 only; v1 fallback deliberately omitted.

All fetched via built-in `fetch` with short timeouts (~1s) so non-AWS
environments fail through the chain instantly. SigV4 signing includes
`X-Amz-Security-Token` when a session token is present (both header-signed
PUTs and presigned GETs). Expiry-aware cache; a delivery that gets a 403
invalidates the cache and retries once with fresh credentials — that plus
staging-based retry (ADR 006) covers rotation races. Still zero runtime
dependencies; testable against MinIO + a stub metadata server in CI.

`flightbox doctor` reports which chain link resolved and when credentials
expire.

## Status

Accepted — implemented with the S3 sink (Week 5 milestone).
