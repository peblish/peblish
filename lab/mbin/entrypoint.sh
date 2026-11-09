#!/bin/sh
# Lab wrapper around Mbin's docker-entrypoint: trusts the lab CA system-wide (PHP's curl reads the
# system store), creates the OAuth2 server keys once, then hands over.
set -e
cp /lab-ca/root.crt /usr/local/share/ca-certificates/lab-root.crt
update-ca-certificates >/dev/null
keys=/app/config/oauth2
if [ ! -f "$keys/private.pem" ]; then
	mkdir -p "$keys"
	openssl genrsa -aes256 -passout "pass:$OAUTH_PASSPHRASE" -out "$keys/private.pem" 2048 2>/dev/null
	openssl rsa -in "$keys/private.pem" -passin "pass:$OAUTH_PASSPHRASE" -pubout -out "$keys/public.pem" 2>/dev/null
	chmod 644 "$keys/private.pem" "$keys/public.pem"
fi
exec docker-entrypoint "$@"
