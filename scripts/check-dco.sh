#!/bin/sh
# Fails unless every non-merge commit in <base>..<head> carries a Signed-off-by line for its
# author (git commit -s), per the DCO. Bot commits (author *[bot]@users.noreply.github.com,
# such as Renovate's) are exempt: a bot cannot certify the DCO.
set -eu
base=${1:?usage: sh scripts/check-dco.sh <base> <head>}
head=${2:?usage: sh scripts/check-dco.sh <base> <head>}
missing=0
for commit in $(git rev-list --no-merges "$base..$head"); do
  email=$(git log -1 --format='%ae' "$commit")
  case "$email" in
    *'[bot]@users.noreply.github.com')
      echo "DCO: $(git log -1 --format='%h %s' "$commit") is a bot commit ($email), exempt"
      continue
      ;;
  esac
  author=$(git log -1 --format='%an <%ae>' "$commit")
  if ! git log -1 --format='%B' "$commit" | grep -qiF "Signed-off-by: $author"; then
    echo "DCO: $(git log -1 --format='%h %s' "$commit") has no 'Signed-off-by: $author'"
    missing=1
  fi
done
[ "$missing" = 0 ] && echo "DCO: every commit in $base..$head is signed off"
exit "$missing"
