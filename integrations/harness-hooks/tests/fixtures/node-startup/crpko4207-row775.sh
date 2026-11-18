git diff --check
node --check scripts/lib/kafka-client-release-admission.mjs
node --check scripts/lib/kafka-installation.mjs
git diff --stat
terraform fmt -check terraform/roots/dev/kafka_client_admission.tf
