cat > tmp/quint/1606/gate-snippet.txt <<'EOF'
const EDGE_OTP_MARKER = "EDGE_OTP_HOME_SHARD";
const TASK_DEFINITION_ARN = /^arn:aws(?:-us-gov|-cn)?:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:[1-9]\d*$/;

function edgeOtpMarked(definition, arn) {
  if (!definition || definition.taskDefinitionArn !== arn || !Array.isArray(definition.containerDefinitions)) {
    throw new Error(`${arn}: invalid task definition readback`);
  }
  const containers = definition.containerDefinitions.filter((container) => container?.name === "edge-api");
  if (containers.length !== 1 || (containers[0].environment != null && !Array.isArray(containers[0].environment))) {
    throw new Error(`${arn}: missing or ambiguous edge-api application container`);
  }
  const markers = (containers[0].environment ?? []).filter((entry) => entry?.name === EDGE_OTP_MARKER);
  if (markers.length > 1 || (containers[0].secrets ?? []).some((entry) => entry?.name === EDGE_OTP_MARKER)) {
    throw new Error(`${arn}: ambiguous ${EDGE_OTP_MARKER}`);
  }
  return markers.length === 1 && markers[0].value === "1";
}

function completedEdgeTaskDefinition(deployment, env, mode) {
  const content = deployment.revision?.appSpecContent?.content;
  let fromRevision;
  if (content != null) {
    if (typeof content !== "string" || !content.trim()) throw new Error("invalid completed deployment AppSpec");
    if (content.trimStart().startsWith("{")) {
      const spec = JSON.parse(content);
      const resources = spec.Resources;
      const targets = Array.isArray(resources)
        ? resources.flatMap((resource) => resource?.TargetService ? [resource.TargetService] : [])
        : resources?.TargetService ? [resources.TargetService] : [];
      if (targets.length !== 1 || targets[0].Type !== "AWS::ECS::Service") throw new Error("invalid completed deployment AppSpec target");
      fromRevision = targets[0].Properties?.TaskDefinition;
    } else {
      // Accept the YAML emitted by this release script, including plain/single quoted scalars.
      const matches = [...content.matchAll(/^\s*TaskDefinition:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#"']+))\s*(?:#.*)?$/gm)];
      if (matches.length !== 1) throw new Error("missing or ambiguous completed deployment AppSpec task definition");
      fromRevision = matches[0][1] ?? matches[0][2] ?? matches[0][3];
    }
    if (typeof fromRevision !== "string" || !TASK_DEFINITION_ARN.test(fromRevision)) throw new Error("invalid completed deployment task definition ARN");
  }
  const description = typeof deployment.description === "string" ? deployment.description.split(/\s+/) : [];
  const fromDescription = description.length === 4 && description[0] === "crpko"
    && description[1] === env && description[2] === mode && TASK_DEFINITION_ARN.test(description[3])
    ? description[3] : undefined;
  if (fromRevision && fromDescription && fromRevision !== fromDescription) throw new Error("completed deployment revision/description disagree");
  if (!fromRevision && !fromDescription) throw new Error("cannot resolve completed deployment task definition");
  return fromRevision ?? fromDescription;
}

// Broker native-v1 e1bf746d, Deployment §5.15 / Config §1.1: the marker
// covers home-shard OTP rules, pending delivery and the OTP verify move fence.
export function edgeOtpHomeShardReleaseGate({ serviceName, candidateTaskDefinitionArn,
  applicationName, deploymentGroupName, env, mode, query = awsJson }) {
  if (serviceName !== "edge-api") return;
  const refuse = (reason) => new Error(`${candidateTaskDefinitionArn}: ${EDGE_OTP_MARKER} release refused: ${reason}`);
  if (!TASK_DEFINITION_ARN.test(candidateTaskDefinitionArn ?? "")) throw refuse("invalid candidate task definition ARN");
  const readMarked = (arn) => {
    try {
      return edgeOtpMarked(query(["ecs", "describe-task-definition", "--task-definition", arn])?.taskDefinition, arn);
    } catch {
      throw refuse(`cannot read or validate task definition ${arn}`);
    }
  };
  const candidateMarked = readMarked(candidateTaskDefinitionArn);
  let nextToken;
  const tokens = new Set();
  do {
    const argv = ["deploy", "list-deployments", "--application-name", applicationName,
      "--deployment-group-name", deploymentGroupName, "--include-only-statuses", "Succeeded", "--no-paginate"];
    if (nextToken) argv.push("--next-token", nextToken);
    let response;
    try { response = query(argv); } catch { throw refuse("cannot list succeeded deployments"); }
    if (!Array.isArray(response?.deployments) || response.deployments.some((id) => typeof id !== "string" || !id)) {
      throw refuse("invalid succeeded deployment list");
    }
    for (const id of response.deployments) {
      let deployment;
      try { deployment = query(["deploy", "get-deployment", "--deployment-id", id])?.deploymentInfo; }
      catch { throw refuse(`cannot read completed deployment ${id}`); }
      if (deployment?.deploymentId !== id || deployment.status !== "Succeeded"
        || deployment.applicationName !== applicationName || deployment.deploymentGroupName !== deploymentGroupName) {
        throw refuse(`invalid completed deployment ${id}`);
      }
      let arn;
      try { arn = completedEdgeTaskDefinition(deployment, env, mode); }
      catch { throw refuse(`cannot resolve completed deployment ${id} task definition`); }
      if (arn.slice(0, arn.lastIndexOf(":")) !== candidateTaskDefinitionArn.slice(0, candidateTaskDefinitionArn.lastIndexOf(":"))) {
        throw refuse(`completed deployment ${id} task definition belongs to another family`);
      }
      if (readMarked(arn)) {
        if (!candidateMarked) throw refuse(`marked deployment ${id} has completed; candidate lacks ${EDGE_OTP_MARKER}=1`);
        return { markedDeploymentId: id };
      }
    }
    nextToken = response.nextToken;
    if (nextToken != null && (typeof nextToken !== "string" || !nextToken || tokens.has(nextToken))) {
      throw refuse("invalid or repeated succeeded deployment page token");
    }
    if (nextToken) tokens.add(nextToken);
  } while (nextToken);
  return { markedDeploymentId: null };
}

EOF
python3 - <<'PY'
from pathlib import Path
p=Path('scripts/deploy-public-ecs-codedeploy.mjs')
s=p.read_text().replace('export function createDeploymentWhenGroupIdle({',Path('tmp/quint/1606/gate-snippet.txt').read_text()+'export function createDeploymentWhenGroupIdle({')
s=s.replace('  sleepNow = sleep\n}) {','  sleepNow = sleep,\n  beforeCreate\n}) {',1).replace('    if (blockingIds.length === 0) {\n      try {','    if (blockingIds.length === 0) {\n      beforeCreate?.();\n      try {',1)
s=s.replace('    deploymentGroupName: group.deployment_group_name,\n    createArgv:', '    deploymentGroupName: group.deployment_group_name,\n    beforeCreate: () => edgeOtpHomeShardReleaseGate({\n      serviceName, candidateTaskDefinitionArn: taskDefinition.taskDefinitionArn,\n      applicationName: group.app_name, deploymentGroupName: group.deployment_group_name, env, mode\n    }),\n    createArgv:',1)
p.write_text(s)
import json
p=Path('plan/devops-runtime-values.json');d=json.loads(p.read_text());d['services']['edge-api']['env']['EDGE_OTP_HOME_SHARD']={'value':'1','source':'Edge API Deployment §5.15 deployment marker','required':True};p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
p=Path('scripts/fixtures/edge-api-required-env.json');d=json.loads(p.read_text());d['requiredEnvKeys'].append('EDGE_OTP_HOME_SHARD');d['note']+=' EDGE_OTP_HOME_SHARD is required by deployment admission, not read by the binary; it marks home-shard OTP rules, pending delivery and the OTP verify move fence (Broker native-v1 e1bf746d, Config §1.1).';p.write_text(json.dumps(d,indent=2)+'\n')
PY
node --check scripts/deploy-public-ecs-codedeploy.mjs