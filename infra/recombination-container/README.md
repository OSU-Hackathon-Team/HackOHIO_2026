# Candidate container policy for recombination

The normal production image serves the API, but its generated-code sandbox uses
Bubblewrap to create nested user, PID, mount, IPC, UTS and network namespaces.
Docker's default seccomp/AppArmor policies and masked `/proc` paths block that
setup. These files are an **opt-in candidate**, not an approved production
deployment policy. They were exercised on the current Ubuntu 26.04 x64 host with
Docker 29.1.3 and AppArmor. A separate security review and deployment-specific
limits remain required.

`seccomp.candidate.json` derives from [Moby's default seccomp profile at
`6fe7deb`](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)
(source SHA-256 `6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`).
It retains the default allowlist and adds permission for `unshare`, `mount`,
`umount2`, and `pivot_root`. It also permits `clone` with `CLONE_NEWUSER` through
a masked argument rule; the default process-clone rules remain. This is tied to
the pinned upstream profile and must be reviewed again when Docker's default
profile or the host architecture changes.

`apparmor.candidate` starts with Moby's `docker-default` proc, sysfs and socket
family denials and adds the user namespace and mount operations Bubblewrap
needs. The container runs as UID 65532 with `--cap-drop=ALL`,
`no-new-privileges`, a read-only root filesystem, a writable `/tmp`, and a
dedicated state mount. Docker's `systempaths=unconfined` is also required here:
its default masked `/proc` paths prevent a nested procfs mount. That flag
weakens the container's normal system-path protection, so the full combination
needs review. The profile grants mount operations to the entire container; it
is not an executable-specific Bubblewrap transition. The generated worker's
Bubblewrap filesystem and network boundaries remain essential.

Build the current image, then run the opt-in probe on an AppArmor host with
passwordless sudo for Docker, AppArmor and the temporary state directory:

```sh
sudo docker build --target runner -t splice-recombination:current .
node scripts/testRecombinationContainerPolicy.mjs splice-recombination:current
```

The probe loads the named AppArmor profile on the host, starts and removes a
temporary container, and removes its state directory. It checks the container's
UID, capabilities, seccomp and AppArmor confinement; verifies that the nested
worker has no effective capabilities, cannot see `/app`, and cannot reach the
container's loopback API; seeds four authored packages; builds the notebook;
previews 60; restarts; and previews 80 from the saved app. The AppArmor profile
remains loaded after the probe, as kernel policy is host configuration.

Passing this probe establishes a working development deployment on this host.
It does not prove that the policy is safe on other hosts or against hostile
generated code. Before production use, review the policy's namespace and mount
surface, Docker system-path unmasking, resource limits, state mount, and host
compatibility. The CI container smoke still tests only startup and API bundling.
