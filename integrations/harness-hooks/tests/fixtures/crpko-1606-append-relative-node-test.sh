cat >> scripts/test-deploy-public-ecs-codedeploy.mjs <<'EOF'

for (const source of ["old", "missing", "compatible"]) {
  test(`bootstrap Edge revision starts unmarked and ${source} source is checked before rollout`, () => {
    const mode = "edge-api-api";
    const sha = source === "compatible" ? EDGE_OTP_FIRST_COMPATIBLE_SOURCE : "b".repeat(40);
    const image = `123456789012.dkr.ecr.ap-south-1.amazonaws.com/crpko/dev/edge-api@${validDigest}`;
    const h = makeHarness({ modes: [{ mode, serviceName: "edge-api", taskDefinition: baseTaskDefinition("dev", mode, "edge-api", image, [
      { name: "EDGE_OTP_HOME_SHARD", value: "0" },
      ...(source === "missing" ? [] : [{ name: "CRPKO_GIT_SHA", value: sha }])
    ]) }] });
    try {
      const state = JSON.parse(readFileSync(h.statePath, "utf8"));
      state.otpImageSources = { [validDigest]: sha };
      state.otpAncestry = { [sha]: source === "compatible" ? "identical" : "behind" };
      writeFileSync(h.statePath, JSON.stringify(state));
      const result = h.run(["--service-mode", mode]);
      const task = result.state.registered.at(-1).taskDefinition;
      assert.equal(task.containerDefinitions[0].image, image);
      assert.equal(envMap(task, "edge-api").get("EDGE_OTP_HOME_SHARD"), source === "compatible" ? "1" : "0");
      assert.equal(result.state.deployments.length, 1);
    } finally { rmSync(h.dir, { recursive: true, force: true }); }
  });
}
EOF
python3 - <<'PY'
from pathlib import Path
import json
p=Path('package.json');s=json.loads(p.read_text());s['scripts']['test:edge-otp-marker:terraform']='node --test scripts/test-edge-otp-marker-terraform.mjs'
s['scripts']['test']+=' && node --test scripts/test-edge-otp-marker-terraform.mjs'
p.write_text(json.dumps(s,indent=2)+'\n')
PY
node --test --test-name-pattern='bootstrap Edge revision' scripts/test-deploy-public-ecs-codedeploy.mjs