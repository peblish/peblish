# peblish federation lab. Run from lab/. The lab is a Docker singleton: one at a time.
COMPOSE := docker compose
# Every profile, so down and reset also remove the opt-in containers.
COMPOSE_ALL := $(COMPOSE) --profile host --profile tools
PEERS ?= lemmy piefed mbin
PROJECT := feddit-lab
# The four hosts that federate; the rogue (rogue.lab.test) is on no allowlist, on purpose.
LAB_HOSTS := piefed.lab.test lemmy.lab.test mbin.lab.test peblish.lab.test

.PHONY: up ports down reset ps logs stats guard

# Refuses to start when containers of this project are running from another worktree's lab/:
# two labs would fight over the same volumes, network and names.
guard:
	@other=$$(docker ps --filter label=com.docker.compose.project=$(PROJECT) \
	  --format '{{.Label "com.docker.compose.project.working_dir"}}' | grep -vx '$(CURDIR)' | sort -u); \
	if [ -n "$$other" ]; then \
	  echo "The lab is running from another worktree: $$other"; \
	  echo "Stop it there first (make down), then run make up here."; exit 1; fi

## Build the peblish image (and PieFed once), start every service (no host ports).
up: guard
	$(COMPOSE) build peblish-migrate
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

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

stats:
	docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $$($(COMPOSE) ps -q)
