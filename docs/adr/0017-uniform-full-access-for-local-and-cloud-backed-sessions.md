---
status: accepted
---

# Give local and cloud-backed Agent Sessions the same explicit Full Access ceiling

When the user explicitly selects Full Access for an Agent Session in a trusted Project, the endpoint's local Runtime or harness may execute filesystem, command, network, and approval-sensitive work with the same host capability ceiling as accepted Codex Full Access, whether the model itself is local or cloud-backed and whether it is a Supervisor or Worker. A cloud model exercises that authority through its local Runtime binding; it does not need a separate public inbound port, tunnel, copied credential, or provider-to-host control channel.

Full Access remains an independently visible Session Profile choice and is never inferred from a model name, endpoint location, Supervisor role, or delegation direction. A more restrictive selected Access Mode remains restrictive, and Project trust, runtime-owned authentication, durable authorization, sanitization, and per-Session audit rules still apply.
