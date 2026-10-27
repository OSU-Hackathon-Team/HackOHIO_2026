#!/bin/sh
set -eu
case "${SPLICE_PACKAGE_NAME:-}" in
  splice-app-????????????????????????????????) ;;
  *) printf 'Invalid package command\n' >&2; exit 2 ;;
esac
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/app.deb xvfb > /tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }
if command -v node >/dev/null 2>&1; then printf 'Unexpected external Node runtime\n' >&2; exit 1; fi
useradd -m -s /bin/sh tester
set +e
timeout 18 runuser -u tester -- xvfb-run -a "/usr/bin/$SPLICE_PACKAGE_NAME" > /tmp/app.log 2>&1
launch_status=$?
set -e
if [ "$launch_status" -ne 124 ]; then cat /tmp/app.log; exit 1; fi
if [ ! -f /home/tester/.config/meeting-notebook/splice-state/state.db ]; then cat /tmp/app.log; exit 1; fi
printf 'Fresh Debian container installed the package and initialized durable state.\n'
