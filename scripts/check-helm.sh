#!/usr/bin/env bash
# Render the chart and prove secrets stay out of the Deployment and TRUSTED_PROXY is settable.
set -euo pipefail
cd "$(dirname "$0")/.."

image=alpine/helm:3.16.2
planted=planted-admin-token-9f3a
encoded=$(printf '%s' "$planted" | base64 | tr -d '\n')

helm() {
  docker run --rm -v "$PWD/deploy/helm/garage-ui:/chart:ro" "$image" "$@"
}

fail() {
  echo "check-helm: $1" >&2
  exit 1
}

# Print the rendered document of one kind ($1) from a multi-document stream on stdin.
document() {
  awk -v kind="$1" '
    /^---$/ { if (keep) printf "%s", doc; doc = ""; keep = 0; next }
    { doc = doc $0 "\n" }
    $0 == "kind: " kind { keep = 1 }
    END { if (keep) printf "%s", doc }
  '
}

helm lint /chart --set secrets.garageAdminToken=$planted --set trustedProxy=true >/dev/null ||
  fail 'helm lint failed'

rendered=$(helm template t /chart --set secrets.garageAdminToken=$planted --set trustedProxy=true)
deployment=$(document Deployment <<<"$rendered")
secret=$(document Secret <<<"$rendered")

[[ -n $deployment ]] || fail 'no Deployment rendered'
if grep -qF "$planted" <<<"$deployment"; then
  fail 'the planted token appears in the Deployment'
fi
[[ -n $secret ]] || fail 'no Secret rendered'
grep -qF 'name: t-secrets' <<<"$secret" || fail 'the Secret is not named <release>-secrets'
grep -qF "$encoded" <<<"$secret" || fail 'the base64 token is missing from the Secret'
grep -q 'secretKeyRef:' <<<"$deployment" || fail 'the Deployment has no secretKeyRef'
grep -A4 'name: GARAGE_ADMIN_TOKEN' <<<"$deployment" | grep -qF 'name: t-secrets' ||
  fail 'GARAGE_ADMIN_TOKEN does not reference the Secret'
grep -A1 'name: TRUSTED_PROXY' <<<"$deployment" | grep -qF 'value: "true"' ||
  fail 'TRUSTED_PROXY "true" is not set'

defaults=$(helm template t /chart)
if grep -q '^kind: Secret$' <<<"$defaults"; then
  fail 'default values render a Secret'
fi
if grep -q 'TRUSTED_PROXY' <<<"$defaults"; then
  fail 'default values set TRUSTED_PROXY'
fi

echo 'check-helm: ok'
