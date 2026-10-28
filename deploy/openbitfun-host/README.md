# Optional full-stack deployment templates

This directory contains reusable templates for self-hosting OpenBitFun
components. It does not describe the official hosted service, and no official
hostnames, SSH aliases, credentials, or production data belong here.

## What is here

| Path | Purpose |
| --- | --- |
| `nginx-openbit.fun.conf` | Website and download vhost example |
| `nginx-playbook.openbitfun.com.conf` | Playbook vhost example |
| `nginx-remote.openbit.fun.conf` | Relay vhost example |
| `nginx-api.openbit.fun.conf` | Generic API gateway vhost example |
| `release-sync.cron` | Optional cron entry for mirroring GitHub releases |
| `migrate-market-data-v1.py` | One-time data migration for pre-rename market data |
| `test_migrate_market_data_v1.py` | Tests for the migration tool |

Filenames keep their historical domain names so existing deployments can find
them. Replace every `server_name`, certificate path, and upstream with your own
values before installing them. All vhosts assume TLS terminates at your reverse
proxy or WAF and the origin listens on port 80.

## Nginx templates

1. Copy the template to `/etc/nginx/sites-available/<your-domain>.conf`.
2. Replace example domains, certificate paths, and upstreams.
3. Keep the default-server 404 from
   [`../miniapp-market/nginx-default-server.conf`](../miniapp-market/nginx-default-server.conf)
   so unknown Host headers do not reach another service.
4. Run `nginx -t`, reload, and verify with explicit `Host` headers.

## Release mirror (optional)

[`scripts/openbitfun-release-sync.sh`](../../scripts/openbitfun-release-sync.sh)
mirrors GitHub release assets to a local directory. If you operate a download
mirror, review the script's environment variables, adjust
`OPENBITFUN_BASE_URL` and the target directory, and install
[`release-sync.cron`](release-sync.cron) only after merging it with your
existing crontab. `crontab release-sync.cron` replaces the entire root crontab.

## Legacy market data migration

[`migrate-market-data-v1.py`](migrate-market-data-v1.py) performs a one-time
migration of pre-rename MiniApp and Skin market data. It refuses to run against
the live database when `--live-database` points at the same path. Work on a
copy, keep the original, and verify SQLite `integrity_check` plus package
checksums before switching traffic.

Run the tests before modifying it:

```bash
python3 -m unittest test_migrate_market_data_v1.py
```

## Related guides

- MiniApp market: [`../miniapp-market/README.md`](../miniapp-market/README.md)
- Skin market: [`../skin-market/README.md`](../skin-market/README.md)
- Relay: [`../relay-v1/README.md`](../relay-v1/README.md) and
  [`../../src/apps/relay-server/README.md`](../../src/apps/relay-server/README.md)
- Outbound mail: [`../outbound-mail/README.md`](../outbound-mail/README.md)
