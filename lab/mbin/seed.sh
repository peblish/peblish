#!/bin/sh
# Mbin's console half of `make seed`, run from lab/ on the host. The API half (the two bot users
# and their OAuth2 clients) is tools/interop/src/seed.ts, which runs first.
set -e
console="docker compose exec -T mbin-php bin/console"
# The bot users exist now; give the admin its role, make sure every local actor has keys, and
# create the community under it.
# Bot users start unverified (no mail runs).
for user in mbinadmin mbinuser; do $console mbin:user:verify -a $user; done
$console mbin:user:admin mbinadmin
$console mbin:ap:keys:update
$console mbin:magazine:create lab --owner mbinadmin --title "Mbin lab" --description "Mbin side of the lab" || echo "(magazine exists)"
# Allowlist mode (MBIN_USE_FEDERATION_ALLOW_LIST): only the lab hosts federate. The rogue is not here.
for domain in mbin.lab.test peblish.lab.test lemmy.lab.test piefed.lab.test; do
	docker compose exec -T mbin-db psql -U mbin -q -c "insert into instance (id, domain, failed_delivers, created_at, is_explicitly_allowed) select coalesce(max(id), 0) + 1, '$domain', 0, now(), true from instance on conflict (domain) do update set is_explicitly_allowed = true, is_banned = false"
done
