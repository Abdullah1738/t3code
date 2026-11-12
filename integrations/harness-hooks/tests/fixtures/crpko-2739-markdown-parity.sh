cat > /tmp/c1050-pr-body.md <<'EOF'
Carries #1050 from main-dev into native-v1: ws-gateway `WS_AUTH_TIMEOUT_MS` goes from 3000 to 8000, so a valid AUTH on a slow network path isn't closed as `1008 UNAUTHORIZED` before it arrives (CRP-13756).

- `plan/devops-runtime-values.json`: `services.ws-gateway.env.WS_AUTH_TIMEOUT_MS` 3000 -> 8000.
- `plan/devops-terraform-build-spec.json`: the same value in the embedded copy. That copy was merged leaf by leaf, so native-v1's other runtime values are unchanged; the embedded and standalone files match byte for byte.
- `scripts/test-deploy-public-ecs-codedeploy.mjs`: the deploy-path case from #1050 (a live task definition on 3000 registers one on 8000, other env unchanged). It fails with the value back at 3000.

Checks: the deploy test file, `test-plan-runtime-env.mjs` and `validate-plan-package.mjs plan` pass.
EOF
rg -n 'shard|name:|Redis plan guard|unit [0-9]|branches:' .github/workflows/terraform-dev.yml | head -n 50
 git diff --cached --name-only
 node /tmp/c1050-parity.mjs HEAD
 git diff --cached --check
 git rev-parse origin/native-v1
 tail -n 8 tmp/card-2739/offbox-node22.log