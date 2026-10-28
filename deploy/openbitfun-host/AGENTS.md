# Self-hosted deployment templates

This directory holds community self-hosting templates. Read
[README.md](README.md) before changing the Nginx examples, cron file, release
mirror, migration tool, or either market deployment.

- Never commit real hostnames, SSH aliases, credentials, tokens, certificates,
  production data, or other operational secrets.
- Examples use placeholder domains and paths. Keep them generic.
- Do not invent a second copy of `scripts/openbitfun-release-sync.sh`. Cron must
  run the in-repo script from the OpenBitFun checkout.
- MiniApp and Skin markets have their own runbooks. Do not mix their checkouts,
  secrets, or Compose projects.
- Back up data with the SQLite backup API and verify integrity before running a
  migration. Do not use destructive Git commands to force a deployment.
