#!/usr/bin/env bash
# Plan B: manual registration with curl (ТЗ §1: any HTTP client counts).
# The password is read from the terminal, never from argv or history.
# Usage: scripts/register.sh <username> "<display name>" <owner/repo> [uk|en] [api-base]
# The one-time application code (invitation) is read from the terminal too.
set -euo pipefail
user=${1:?username}; name=${2:?display name}; repo=${3:?owner/repo}; lang=${4:-uk}
api=${5:-https://zoria.net/api/v1}
read -r -s -p "password: " pass; echo
read -r -p "код заявки (invitation): " invitation
user=$(printf '%s' "$user" | tr '[:upper:]' '[:lower:]')
body=$(node -e 'console.log(JSON.stringify({username:process.argv[1],displayName:process.argv[2],password:process.argv[3],invitation:process.argv[4],repositoryUrl:process.argv[5],lang:process.argv[6]}))' "$user" "$name" "$pass" "$invitation" "$repo" "$lang")
echo "POST $api/auth/register"
code=$(curl -sS -o /tmp/zoria-register.$$ -w '%{http_code}' -X POST "$api/auth/register" -H 'Content-Type: application/json' --data-binary @- <<<"$body") || code=000
echo "status $code"; head -c 400 /tmp/zoria-register.$$ | sed 's/"token":"[^"]*"/"token":"<hidden>"/'; echo
rm -f /tmp/zoria-register.$$
if [[ $code == 000 || $code == 5* || $code == 409 ]]; then
  # Lost answer or name taken: log in first, never register blindly a second time (CL-17).
  echo "checking with login…"
  lbody=$(node -e 'console.log(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' "$user" "$pass")
  curl -sS -o /dev/null -w 'login status %{http_code} (200 = account exists and is yours)\n' -X POST "$api/auth/login" -H 'Content-Type: application/json' --data-binary @- <<<"$lbody"
fi
