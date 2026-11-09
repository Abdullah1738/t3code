cat > tmp/142/loops.sh <<'FIXTURE_EOF'
#!/bin/bash
set -u
repo=$(pwd -L)
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk"
cd "$repo"
python3 "$repo/tmp/142/campaign.py" "$@"
FIXTURE_EOF
