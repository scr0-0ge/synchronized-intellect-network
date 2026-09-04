# Shared test isolation

The top-level `test` script pins Node's `--test-isolation=process` mode because
the suite temporarily changes process-wide state and opens native/Vite resources.
The helpers in this directory restore state within one test-file process; process
isolation is the cross-file boundary and must not be left to Node's default.

Temporary resources use OS-temp roots. Register them as soon as they are acquired:
unblockers and disposers run first, closable owners run second, and directory
removal runs last with bounded retries.
