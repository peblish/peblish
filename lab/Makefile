# Feddit federation lab. Run from lab/.
COMPOSE := docker compose
# Every profile, so down and reset also remove the opt-in containers.
COMPOSE_ALL := $(COMPOSE) --profile host --profile tools
CAPTURES := ../spikes/fedify-threadiverse/captures
PEERS ?= lemmy piefed

.PHONY: up ports down reset seed scenarios moderation collision durability check captures ps logs restart-feddit typecheck stats

## Build the Feddit spike image and start every service (no host ports).
up:
	$(COMPOSE) build feddit
	# PieFed is built from Codeberg once; later runs reuse the local image.
	@docker image inspect feddit-lab/piefed:1.8.11 >/dev/null 2>&1 || $(COMPOSE) build piefed-web
	$(COMPOSE) up -d
	@echo "All lab networks are internal. For host access: make ports"
	@echo "Next: make seed"

## Opt-in host access through the host-ports forwarder (127.0.0.1 only).
ports:
	$(COMPOSE) --profile host up -d host-ports
	@echo "Lemmy  http://localhost:18201   PieFed http://localhost:18202   Feddit http://localhost:18203"
	@echo "HTTPS for every *.lab.test name on 127.0.0.1:18243 (curl --resolve, CA in lab/data/lab-ca.crt)"

## Stop everything, keep data.
down:
	$(COMPOSE_ALL) down

## Stop everything and delete all lab data (databases, CA, queues).
reset:
	$(COMPOSE_ALL) down -v --remove-orphans
	rm -rf data

## Create admins, users and test communities on Lemmy, PieFed and Feddit.
seed:
	@echo "Waiting for PieFed migrations..."
	@until $(COMPOSE) exec -T piefed-web pgrep -f gunicorn >/dev/null 2>&1; do sleep 2; done
	# PieFed's allowlist check also runs on its own actors (validate_remote_actor),
	# so its own domain must be listed or Follows to local communities fail.
	$(COMPOSE) exec -T piefed-web python /lab/bootstrap.py piefed.lab.test lemmy.lab.test feddit.lab.test
	# Drop PieFed's in-process caches of site settings.
	$(COMPOSE) restart piefed-web piefed-celery
	$(COMPOSE) run --rm runner node scenarios/seed.ts
	# Lemmy (release build) starts its outbound worker for a newly seen instance
	# on a 60 s timer, and that worker skips every activity queued before it
	# started. Wait for both lab peers' workers so the first Follow is not lost.
	@echo "Waiting for Lemmy's outbound workers for the lab peers (up to about 60 s)..."
	@until [ "$$($(COMPOSE) exec -T lemmy-db psql -U lemmy -At -c 'select count(*) from federation_queue_state')" -ge 2 ]; do sleep 5; done
	@mkdir -p data
	$(COMPOSE) cp caddy:/data/caddy/pki/authorities/local/root.crt data/lab-ca.crt
	@echo "Lab CA written to lab/data/lab-ca.crt"

## Run the interop scenarios (PEERS="lemmy piefed" by default).
# PieFed caps posts by accounts it first saw under 24 h ago (can_create_post,
# hard-coded). Repeated lab runs would hit it, so remote accounts are aged first.
scenarios:
	$(COMPOSE) exec -T piefed-db psql -U piefed -q -c \
	  "update \"user\" set created = now() - interval '2 days' where instance_id <> 1"
	$(COMPOSE) run --rm runner node scenarios/run.ts $(PEERS)

## Moderation set (S10-S14, M0-M4, P0-P5) and the authorization refusals (N0-N15).
moderation:
	$(COMPOSE) exec -T piefed-db psql -U piefed -q -c \
	  "update \"user\" set created = now() - interval '2 days' where instance_id <> 1"
	$(COMPOSE) run --rm runner node scenarios/moderation.ts $(PEERS)
	$(COMPOSE) run --rm runner node scenarios/authz.ts

## A Person and a Group sharing one name: WebFinger and resolution on each peer.
collision:
	$(COMPOSE) run --rm runner node scenarios/collision.ts $(PEERS)

## Delivery policy and crash recovery (D1-D7). Kills the Feddit container with
## SIGKILL between the two phases, while deliveries are queued and in flight.
durability:
	$(COMPOSE) run --rm runner node scenarios/durability.ts before
	$(COMPOSE) kill -s SIGKILL feddit
	$(COMPOSE) up -d feddit
	$(COMPOSE) run --rm runner node scenarios/durability.ts after

## The whole clean sequence, from an empty lab. -k: a failing step does not
## skip the later ones (the run still exits non-zero).
check:
	$(MAKE) -k reset up seed scenarios moderation collision durability captures

## Dump what Lemmy sent and what PieFed logged into the captures directory.
captures:
	$(COMPOSE) exec -T lemmy-db psql -U lemmy -At -c \
	  "select json_build_object('id', id, 'ap_id', ap_id, 'published', published, 'send_inboxes', send_inboxes, 'data', data) from sent_activity order by id" \
	  > $(CAPTURES)/lemmy-sent_activity.jsonl
	$(COMPOSE) exec -T piefed-db psql -U piefed -At -c \
	  "select json_build_object('id', id, 'activity_id', activity_id, 'activity_type', activity_type, 'direction', direction, 'result', result, 'exception_message', exception_message, 'created_at', created_at, 'activity_json', activity_json) from activity_pub_log order by id" \
	  > $(CAPTURES)/piefed-activity_pub_log.jsonl
	# What each peer recorded about Feddit's instance actor and NodeInfo.
	$(COMPOSE) exec -T lemmy-db psql -U lemmy -At -c \
	  "select json_build_object('site_name', s.name, 'actor_id', s.actor_id, 'inbox_url', s.inbox_url, 'has_public_key', s.public_key is not null) from site s join instance i on i.id = s.instance_id where i.domain = 'feddit.lab.test'" \
	  > $(CAPTURES)/lemmy-instance-feddit.json
	$(COMPOSE) exec -T piefed-db psql -U piefed -At -c \
	  "select json_build_object('inbox', inbox, 'outbox', outbox, 'software', software, 'version', version, 'nodeinfo_href', nodeinfo_href, 'dormant', dormant) from instance where domain = 'feddit.lab.test'" \
	  > $(CAPTURES)/piefed-instance-feddit.json
	# The PieFed unban defect (M4), if it happened.
	-$(COMPOSE) logs --no-color piefed-celery | grep -A17 "unban_from_community.*raised unexpected" > $(CAPTURES)/piefed-celery-unban-error.log
	@wc -l $(CAPTURES)/*.jsonl

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

restart-feddit:
	$(COMPOSE) restart feddit

typecheck:
	$(COMPOSE) run --rm --no-deps runner npx tsc --noEmit -p .

stats:
	docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $$($(COMPOSE) ps -q)
