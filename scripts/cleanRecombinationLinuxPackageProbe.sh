#!/bin/sh
set -eu
case "${SPLICE_PACKAGE_NAME:-}" in
  splice-app-????????????????????????????????) ;;
  *) printf 'Invalid package command\n' >&2; exit 2 ;;
esac
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/app.deb xvfb socat > /tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }
if command -v node >/dev/null 2>&1; then printf 'Unexpected external Node runtime\n' >&2; exit 1; fi
useradd -m -s /bin/sh tester
container_ip=$(hostname -i | cut -d ' ' -f1)
socat "TCP-LISTEN:9222,bind=$container_ip,reuseaddr,fork" TCP:127.0.0.1:9222 &
exec runuser -u tester -- xvfb-run -a "/usr/bin/$SPLICE_PACKAGE_NAME" --remote-debugging-port=9222
