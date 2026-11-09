# peblish federation lab. Run from lab/. The lab is a Docker singleton: one at a time.
COMPOSE := docker compose
# Every profile, so down and reset also remove the opt-in containers.
COMPOSE_ALL := $(COMPOSE) --profile host --profile tools
PEERS ?= lemmy piefed mbin
PROJECT := feddit-lab
# The hosts that federate; the rogue (rogue.lab.test) is on no allowlist, on purpose.
LAB_HOSTS := piefed.lab.test lemmy.lab.test mbin.lab.test peblish.lab.test
# Lemmy opens one outbound worker per federating instance it has met (peblish, PieFed).
LEMMY_WORKERS := 2

.PHONY: up ports down reset ps logs stats guard seed interop interop-slow

# Refuses to start when containers of this project are running from another worktree's lab/:
# two labs would fight over the same volumes, network and names.
guard:
	@other=$$(docker ps --filter label=com.docker.compose.project=$(PROJECT) \
	  --format '{{.Label "com.docker.compose.project.working_dir"}}' | grep -vx '$(CURDIR)' | sort -u); \
	if [ -n "$$other" ]; then \
	  echo "The lab is running from another worktree: $$other"; \
	  echo "Stop it there first (make down), then run make up here."; exit 1; fi

## Build the peblish and runner images (and PieFed once), start every service (no host ports).
up: guard
	$(COMPOSE) build peblish-migrate rogue
	# PieFed is built from Codeberg once; later runs reuse the local image.
	@docker image inspect feddit-lab/piefed:1.8.11 >/dev/null 2>&1 || $(COMPOSE) build piefed-web
	$(COMPOSE) up -d
	# PieFed reports unhealthy until its site row exists, so initialise it before waiting.
	@echo "Waiting for PieFed migrations..."
	@until $(COMPOSE) exec -T piefed-web pgrep -f gunicorn >/dev/null 2>&1; do sleep 2; done
	# PieFed's allowlist check also runs on its own actors (validate_remote_actor), so its own
	# domain must be listed or Follows to local communities fail. The rogue is on no list.
	$(COMPOSE) exec -T piefed-web python /lab/bootstrap.py $(LAB_HOSTS)
	# Drop PieFed's in-process caches of site settings.
	$(COMPOSE) restart piefed-web piefed-celery
	$(COMPOSE) up -d --wait
	@echo "All lab networks are internal. For host access: make ports"
	@echo "Next: make seed"

## Opt-in host access through the host-ports forwarder (127.0.0.1 only).
ports:
	$(COMPOSE) --profile host up -d host-ports
	@echo "Lemmy http://localhost:18201  PieFed http://localhost:18202  Mbin http://localhost:18204  peblish http://localhost:18322"
	@echo "HTTPS for every *.lab.test name on 127.0.0.1:18243 (curl --resolve, CA in lab/data/lab-ca.crt)"

## Stop everything, keep data and images.
down:
	$(COMPOSE_ALL) down

## Stop everything and delete all lab data (databases, CA, queues).
reset: guard
	$(COMPOSE_ALL) down -v --remove-orphans
	rm -rf data

## Peers' users and communities; peblish's admin (through the image's own admin.mjs), alice, bob and !lab.
seed:
	@mkdir -p data/results
	# The first admin proves the image bootstraps itself; it refuses when one exists, which is fine.
	@printf '%s' lab-password-1 | $(COMPOSE) exec -T peblish-web node /app/processes/admin.mjs labadmin labadmin@peblish.lab.test || echo "(admin exists)"
	$(COMPOSE) run --rm runner node src/seed.ts
	# Lemmy starts its outbound worker for a newly seen instance on a 60 s timer, and that worker
	# skips every activity queued before it started. Wait for the lab peers' workers.
	@echo "Waiting for Lemmy's outbound workers for the lab peers (up to about 60 s)..."
	@until [ "$$($(COMPOSE) exec -T lemmy-db psql -U lemmy -At -c 'select count(*) from federation_queue_state')" -ge $(LEMMY_WORKERS) ]; do sleep 5; done
	$(COMPOSE) cp caddy:/data/caddy/pki/authorities/local/root.crt data/lab-ca.crt
	@echo "Lab CA written to lab/data/lab-ca.crt"

## Run the scenarios: make interop [PEERS="lemmy piefed mbin"] [ONLY=F1,P1].
# PieFed caps posts by accounts it first saw under 24 h ago (can_create_post, hard-coded), so
# remote accounts are aged first. This is a peer-side lab setting; peblish has none.
interop:
	@mkdir -p data/results
	$(COMPOSE) exec -T piefed-db psql -U piefed -q -c \
	  "update \"user\" set created = now() - interval '2 days' where instance_id <> 1"
	$(COMPOSE) run --rm runner node src/run.ts $(PEERS) $(if $(ONLY),--only=$(ONLY),)

## The slow tier: the Follow resend at 5 and 15 minutes (F3).
interop-slow:
	@mkdir -p data/results
	$(COMPOSE) run --rm runner node src/run.ts $(PEERS) --slow --only=F3

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

stats:
	docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $$($(COMPOSE) ps -q)
