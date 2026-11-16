node --check scripts/runbooks/kafka-acl-probes.mjs
node scripts/runbooks/kafka-acl-probes.mjs --env dev --stage post-topic --dry-run > /dev/null