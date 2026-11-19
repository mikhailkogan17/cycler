#!/usr/bin/env bash
set -euo pipefail
npm ci
npm test
npx tsc --noEmit
echo 'DEMO_GATE_GREEN'
