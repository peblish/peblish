#!/usr/bin/env bash
# Lab copy of PieFed 1.8.11's entrypoint.sh. Upstream also runs
# `flask populate_community_search`, which downloads
# https://data.lemmyverse.net/data/community.full.json on every boot and
# aborts the container (set -e) without internet access. The lab network has
# no egress, so that step is skipped; everything else is unchanged.
set -e
export FLASK_APP=pyfedi.py
echo "Running database migrations..."
flask db upgrade
echo "Starting Gunicorn..."
exec gunicorn --config gunicorn.conf.py --preload pyfedi:app
