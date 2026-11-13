"""Source classifier vectors from the OpenCode coord/offbox policies."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import engine

OFFBOX = SRC.parents[1] / "offbox/skill"


class PolicyParityTests(unittest.TestCase):
    def test_coord_original_classifier_vectors(self):
        denied = {
            "aws-mutation": [
                "aws ecs run-task --help", "aws --profile crpko-dev --region ap-south-1 ecs run-task --cluster dev",
                "env X=1 aws ecs update-service --force-new-deployment", "AWS_PROFILE=dev aws ssm send-command --parameters '{}'",
                "bash -lc 'aws ssm start-session --target abc'", 'sh -c "aws lambda invoke x"',
                "echo ok && aws ec2 create-tags --resources i-1", "aws sts get-caller-identity; aws ecs stop-task --task x",
                "(aws ecs run-task --help) | cat", "offbox ssh -- aws ecs run-task --help",
                'offbox ssh -- "aws ecs run-task --help"', "offbox run -- bash -c 'aws ecs run-task --help'",
                'echo "$(aws ecs run-task --help)"', 'echo `aws ecs run-task --help`',
                'echo "$(echo ok; aws ecs run-task --help)"', "command /opt/homebrew/bin/aws ecs execute-command",
                "sudo -u ardud env X=1 aws ecs delete-service", "timeout 3 aws lambda invoke-async",
                "if true; then aws s3api put-object --bucket x; fi", "aws ecs \\\nrun-task --help",
                "sh <<'EOF'\naws ecs run-task --help\nEOF", "cat <<EOF\n$(aws ecs run-task --help)\nEOF",
            ],
            "secret-read": ["aws secretsmanager get-secret-value --secret-id x", "aws ssm get-parameter --with-decryption --name x", "aws ssm get-parameters --names x --with-decryption", "aws ssm get-parameters-by-path --path /dev --with-decryption", "aws rds-data execute-statement --sql SELECT"],
            "database-direct": ["psql --version", "pg_dump db", "pg_restore x", "fdbcli --exec status", "clickhouse-client --query 'SELECT 1'", "env PGHOST=x psql -c 'SELECT 1'"],
            "clickhouse-http-write": ["curl -X POST http://localhost:8123/", "curl --data-binary @q.sql https://db:8443/", "wget --post-data='SELECT 1' http://db:8123", "curl -d'SELECT 1' http://db:8123", "curl --request=POST https://db:8443"],
            "terraform-mutation": ["terraform apply -auto-approve", "terraform -chdir=env/dev destroy", "terraform import x y", "terraform state rm x", "terraform state mv a b", "terraform state push x", "terraform state replace-provider a b"],
            "coord-control": ["coord claim env:dev", "coord release svc:x", "coord reconcile env:dev", "coord qa list", "coord pause", "coord resume", "coord drain", "coord --as cell-x claim env:dev"],
            "github-write": ["gh pr merge 1", "gh --repo org/repo workflow run deploy", "gh release create v1", "gh api -X POST repos/x", "gh api --method PATCH /repos/x", "gh api --method=DELETE /repos/x", "gh api -XPUT /repos/x"],
            "deploy-script": ["npm run deploy:dev", "npm run runbook:rebuild", "./scripts/deploy-dev.sh", "bash scripts/deploy-dev.sh", "python3 scripts/runbooks/rebuild.py", "bun scripts/runbooks/rebuild.ts"],
            "force-push": ["git push --force origin main", "git -C /repo push --force-with-lease", "git push --force-with-lease=refs/heads/main:abc", "git push -f origin main"],
        }
        allowed = [
            "aws ecs describe-services --services x", "aws ec2 list-tags-for-resource", "aws ssm get-parameter --name x",
            "aws ssm get-parameters-by-path --path /dev --no-with-decryption", "aws logs filter-log-events --filter-pattern 'run-task'",
            "aws logs start-query --log-group-name /aws/ecs/x --start-time 1 --end-time 2 --query-string 'fields @message'", "aws logs get-query-results --query-id q",
            "aws athena start-query-execution --query-string 'SELECT 1'", "gh pr view 1", "gh pr list", "gh pr diff 1", "gh api -X GET /repos/x", "git status", "git diff", "git push origin branch",
            "go test ./...", "offbox run -- go test ./...", "offbox ssh -- 'go test ./...'", "terraform plan", "terraform state list", "terraform state show x", "terraform state pull", "coord inbox --as cell-x", "coord post delivery --body 'coord claim env:dev'",
            "echo 'aws ecs run-task --help'", 'echo "psql --help; aws ecs run-task"', "grep 'aws ecs run-task' file", "rg 'psql|terraform apply' .",
            "cat <<'EOF'\naws ecs run-task\n$(psql)\nEOF", "python3 - <<'PY'\nprint('aws ecs run-task')\nPY",
            "curl http://db:8123/ping", "curl -X POST https://api.example:443/", "npm run test", "bash -c 'echo \"aws ecs run-task\"'",
            "echo 'scripts/deploy-dev.sh'", "ls scripts/runbooks/", "git show HEAD:scripts/deploy-dev.sh",
            "node --check scripts/runbooks/apply.mjs", "node -c scripts/runbooks/apply.mjs", "bash -n scripts/runbooks/apply.sh",
            "node --test scripts/runbooks/test-check.mjs", "node -e 'console.log(\"scripts/runbooks/apply.mjs\")'",
            "python3 -c 'print(\"scripts/runbooks/apply.py\")'", "bash -nc 'aws ecs run-task'",
        ]
        for rule, commands in denied.items():
            for command in commands:
                with self.subTest(command=command):
                    self.assertEqual(engine.classify_coord(command), rule)
        for command in allowed:
            with self.subTest(command=command):
                self.assertIsNone(engine.classify_coord(command))
        # Native classification intentionally scans past a read-only query;
        # OpenCode's early return would miss a later mutation in the same call.
        self.assertEqual(engine.classify_coord("aws logs start-query; aws ecs run-task"), "aws-mutation")

    def test_offbox_uses_shared_rules_and_every_embedded_vector(self):
        spec = importlib.util.spec_from_file_location("offbox_parity_classifier", OFFBOX / "scripts/classify.py")
        classifier = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"OFFBOX_RULES": str(OFFBOX / "heavy-rules.json")}):
            spec.loader.exec_module(classifier)
        rules = json.loads((OFFBOX / "heavy-rules.json").read_text())
        fixtures = str(OFFBOX / "scripts/tests/fixtures")
        with patch.dict(os.environ, {"OFFBOX_RULES": str(OFFBOX / "heavy-rules.json")}):
            for vector in rules["vectors"]:
                cwd = vector.get("cwd")
                if cwd:
                    cwd = cwd.replace("$FIXTURES", fixtures)
                with self.subTest(command=vector["cmd"]):
                    verdict = classifier.classify(vector["cmd"], cwd)
                    self.assertEqual(verdict["heavy"], vector["heavy"])
                    if vector.get("heavy") and vector.get("rule"):
                        self.assertEqual(verdict["rule"], vector["rule"])
                    if "rewrite" in vector:
                        self.assertEqual(verdict["rewrite"], vector["rewrite"])
            with patch.dict(os.environ, {"HARNESS_HOOKS_CLASSIFIER": str(OFFBOX / "scripts/classify.py")}):
                for command in ["npm ci", "docker compose up -d", "go test ./...", "pytest tests/a.py::test_one", "offbox run -- npm ci"]:
                    self.assertEqual(engine._classify_offbox(command, fixtures), classifier.classify(command, fixtures))

    def test_betterstack_original_scope_roots_and_boundaries(self):
        for root in engine.CRPKO_ROOTS:
            for path in (root, root + "/src", root + "-lane"):
                self.assertTrue(engine._betterstack_directory(path), path)
            self.assertFalse(engine._betterstack_directory(root + "s"))
        for path in ("", None, "/Users/ardud/Junocash-Tools", "/Volumes/ExternalSSD/t3code-fork"):
            self.assertFalse(engine._betterstack_directory(path))


if __name__ == "__main__":
    unittest.main()
