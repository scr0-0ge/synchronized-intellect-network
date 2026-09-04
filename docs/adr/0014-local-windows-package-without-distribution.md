---
status: accepted
---

# Build one local Windows package without authorizing distribution

After the accepted native Open Project flow, the Workbench will add one repeatable local Windows x64 packaging command around the existing Vite production output. The bounded implementation uses the Electron-maintained `@electron/packager` layer rather than introducing installer, maker, publishing, update, or signing machinery; it packages only a minimal production manifest plus built main, preload, and renderer files into an ASAR-backed unpacked application folder. Package output is local verification residue, not a release, and is removed after acceptance review.

A packaged launch must never infer trust from the process working directory, executable directory, application resources, or the Workbench data root. When no explicit startup Project is supplied and no durable selection exists, packaged mode uses one dedicated app-owned empty bootstrap Project beneath the Workbench user-data directory. Its exact child boundary is validated fail-closed, it contains no registry, preference, credential, or application files, and it does not authorize any external user directory. Development mode retains the accepted current-working-directory fallback, while real user Projects still enter only through the existing main-owned Open Project action or an explicit native startup switch.

This decision changes no renderer Project Interface, Project Host identity or one-open semantics, coordinator or Agent Runtime Interface, Runtime-owned authentication, trusted Project `full-access`, fixed `single-agent`, or Session Profile rule. Local packaged launch may be exercised with isolated data and deterministic process/window inspection, but no installer, archive for delivery, code signing, auto-update, publication, deployment, distribution, real native chooser invocation, or live Agent Runtime work is authorized.
