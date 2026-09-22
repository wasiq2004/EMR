#!/usr/bin/env bash
#
# Both API suites, against a running server.
#
#   API_BASE=http://localhost:4000/v1 bash scripts/verify/all.sh
set -u
here="$(dirname "$0")"
rc=0
for suite in api-reads consultation-flow; do
  echo "=============================================================="
  echo " $suite"
  echo "=============================================================="
  bash "$here/$suite.sh" || rc=1
  echo
done
exit "$rc"
