# Item N — isolated Vagrant + Ansible VM labs (foundation)

This is a standalone CLI foundation, **not** the Chat Marks desktop VM screen.
It does not access the production profile or automatically start a virtual machine.

Usage (from the repository):

~~~sh
node scripts/marks-vms.mjs init sandbox --memory 2048 --cpus 2
node scripts/marks-vms.mjs list
node scripts/marks-vms.mjs doctor
node scripts/marks-vms.mjs up sandbox --dry-run
node scripts/marks-vms.mjs up sandbox
node scripts/marks-vms.mjs status sandbox
node scripts/marks-vms.mjs provision sandbox
node scripts/marks-vms.mjs halt sandbox
node scripts/marks-vms.mjs destroy sandbox --confirm-destroy sandbox
~~~

The default lab directory on Linux is ~/.local/share/chat-marks/vms unless
XDG_DATA_HOME is set. Use --root with an absolute path to choose another location.
Init exclusively creates a new directory containing Vagrantfile, site.yml and
lab.json with SHA-256 hashes for the generated templates. No credentials are
written; VirtualBox does not automatically share the host directory with guests.
Operations reject altered templates and pass fixed arguments without a shell.
Destroy requires confirmation by the exact VM name.

Real VM operations require Vagrant, VirtualBox, the Ubuntu 24.04 Vagrant box,
and host-side Ansible. The read-only doctor checks tool availability using
fixed version arguments without a shell; on 2026-10-22 it detected VirtualBox,
but not Vagrant or Ansible on the Linux host. No VM was started. The generated playbook only pings the
guest. There is no application IPC or GUI yet, no autonomous provisioning,
and no connection to the vault, profiles or production app.

Next: typed main-process IPC and permissions, UI, host prerequisite checks,
timeout/cancellation/logging, Windows/WSL support, safe lifecycle ownership,
and end-to-end testing with the actual hypervisor before homologation.
