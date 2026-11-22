cat >> tmp/card-5111.0gffvP/STATUS.md <<'EOF'

run-1121-113435-9b1b865e failed16.59s REGISTRY_MISSING. Actual root cause: startNativeRegistryTestRuntime creates context.WithTimeout15s (registry_runtime_test.go120), so this shared dependency always dies before31s. Prior clock explanation was incomplete. Increase testfixture lifetime to1minute; keep original bounded source and cleanup. No productioncodechange.
EOF
GITHUB_TOKEN="$(gh auth token)" offbox run --bg --git --env GITHUB_TOKEN --include tmp/card-5111.0gffvP --pull tmp/card-5111.0gffvP/results -- bash tmp/card-5111.0gffvP/verify.sh after-receiver
