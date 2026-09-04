---
status: accepted
---

# Acquire trusted Projects only through the Electron main process

The Workbench will expose one argument-free `Open Project` renderer action whose owning Electron window opens a native directory chooser; only the main process receives the selected directory and passes it directly to the accepted Project Host's trusted-registration Interface. Choosing a directory is the explicit user grant of the already-accepted trusted Project `full-access` policy, while cancellation is a normal fixed public outcome and the renderer receives no path, native chooser value, durable registry identity, or new trust/policy control. Renderer path entry, drag/drop, recent-folder discovery, directory creation, multiple selection, coordinator or Agent Runtime Interface changes, and any authentication, Access, or host-trust change remain separate decisions.
