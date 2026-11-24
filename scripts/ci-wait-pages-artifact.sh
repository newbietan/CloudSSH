#!/usr/bin/env bash
set -euo pipefail

if [[ ! ${GITHUB_REPOSITORY:-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ||
      ! ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ || ! ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ||
      ! ${PAGES_ARTIFACT_ID:-} =~ ^[0-9]+$ ||
      ${PAGES_ARTIFACT_NAME:-} != "github-pages-${GITHUB_RUN_ID:-}-${GITHUB_RUN_ATTEMPT:-}" ]]; then
  echo '::error::Missing or invalid metadata for the current Pages upload.' >&2
  exit 1
fi

# A successful upload can precede artifact discovery by the deployment service.
# Retry only this read, never the deployment request. Confirm ID, name, run and expiry.
endpoint="repos/$GITHUB_REPOSITORY/actions/artifacts/$PAGES_ARTIFACT_ID"
expected="$PAGES_ARTIFACT_ID $PAGES_ARTIFACT_NAME $GITHUB_RUN_ID false"
for ((attempt = 1; attempt <= 8; attempt++)); do
  if metadata=$(timeout 6s gh api --method GET "$endpoint" \
      --jq '[.id, .name, .workflow_run.id, .expired] | map(tostring) | join(" ")' 2>/dev/null) &&
     [[ "$metadata" == "$expected" ]]; then
    echo 'Pages artifact is visible for this upload.'
    exit 0
  fi
  if (( attempt < 8 )); then sleep 5; fi
done

echo '::error::GitHub did not expose the current Pages artifact in time. Re-run the Pages job or dispatch it on main later.' >&2
exit 1
