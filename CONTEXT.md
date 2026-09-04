# Synchronized Intellect Network

Synchronized Intellect Network is a local work environment for using multiple coding-agent subscriptions through one consistent interface and coordinating their work across shared projects.

That name is the product's brand. The vocabulary below is unchanged by it: **Workbench** is still the domain noun for this product, and every other noun keeps the meaning it already had. The brand is a label on top of the ubiquitous language, not a replacement for it.

## Language

**Workbench**:
The local product that presents projects and Agent Sessions in one consistent user interface.
_Avoid_: Frontend, skin, wrapper

**Project**:
A local directory—newly created or already existing—together with the Agent Sessions and work history associated with it.
_Avoid_: Workspace, repository

**Create Project**:
The explicit user action that creates one new local directory, recognizes it as a trusted Project, and makes it the Selected Project.
_Avoid_: New workspace, blank workspace

**Project Registry**:
The durable local collection of Projects known to the Workbench, including which single Project is selected. It owns Project membership and selection, not any Project's Work Ledger.
_Avoid_: Recent folders, workspace list

**Selected Project**:
The single registered Project whose Agent Sessions and work history are currently open in the Workbench. Selecting another Project changes context without merging either Project's Work Ledger.
_Avoid_: Active workspace, current repository

**Open Project**:
The explicit user action that chooses a local directory, recognizes it as a trusted Project, and makes it the Selected Project. If the directory is already registered, the action selects that existing Project instead of creating a duplicate.
_Avoid_: Import folder, add workspace, recent folder

**Agent Runtime**:
An execution environment that owns its authentication, available models, reasoning controls, permissions, and session lifecycle.
_Avoid_: Provider, account

**Agent Runtime Endpoint**:
A locally configured Workbench destination for an Agent Runtime. It may execute a model on the local machine or reach a remote model while keeping that endpoint's authentication opaque.
_Avoid_: Provider account, model server, API connection

**Runtime Endpoint Directory**:
The Workbench-owned collection of configured Agent Runtime Endpoints and their current sanitized capability snapshots. Its production Interface publishes one immutable exact-snapshot view and authorizes an already accepted bounded Work Order against the actual Supervisor Session supplied separately by the coordinator. It distinguishes exact endpoints and privately resolves the Adapter without owning authentication, transport, native Session identity, or external effects.
_Avoid_: Provider registry, model list, credential store

**Runtime Catalog**:
A normalized snapshot of the models and Session Profile values currently supported by one Agent Runtime, including model-specific option sets and safe Runtime-owned display terminology. It contains capabilities, not authentication data.
_Avoid_: Provider model list, account capabilities

**Agent Session**:
A persistent conversation executed by exactly one Agent Runtime within a Project.
_Avoid_: Chat, thread

**Direct Project Command**:
A user-authored instruction that a Project durably accepts either to start one Agent Session through a selected Session Profile or to continue one selected Agent Session through its immutable Session Profile. Local acceptance does not mean the Agent Runtime has completed the instruction.
_Avoid_: Chat message, prompt

**Supervisor Session**:
An Agent Session responsible for direction, decomposition, delegation, progress review, and acceptance.
_Avoid_: Manager, main chat

**Worker Session**:
An Agent Session assigned a bounded Work Order and expected to return a Handoff.
_Avoid_: Subagent, child chat

**Cross-Runtime Delegation**:
A Work Order sent from a Supervisor Session on one Agent Runtime Endpoint to a Worker Session on any other authorized endpoint through the local Workbench. Supervisor and Worker roles do not imply whether either model is local or remote.
_Avoid_: Direct model-to-model connection, remote-control tunnel

**Work Order**:
A bounded assignment from a Supervisor Session to a Worker Session, including its objective and selected Session Profile.
_Avoid_: Prompt, task

**Handoff**:
A structured progress or completion report returned by a Worker Session to its Supervisor Session.
_Avoid_: Reply, summary

**Session Profile**:
A reusable selection of Agent Runtime, model, Work Intensity, and Access Mode used when starting an Agent Session.
_Avoid_: Defaults, configuration preset

**Work Intensity**:
The Workbench umbrella concept for a model-scoped intensity selection. Its visible control label, complete ordered choices, and choice labels come from the selected Agent Runtime and model; each choice resolves to that Runtime's supported Effort Level and any explicitly coupled Execution Mode.
_Avoid_: Global effort scale, reasoning slider

**Effort Level**:
An Agent Runtime's native setting for how much reasoning a model applies. Values and display terms are not assumed to be shared or equivalent across models or Agent Runtimes.
_Avoid_: Execution mode

**Execution Mode**:
Whether work is performed by one agent or coordinated across multiple agents. It is independent of Effort Level.
_Avoid_: Effort level

**Access Mode**:
The host capability ceiling applied to an Agent Session for filesystem, command, network, and other approval-sensitive work. Its meaning is independent of whether the model executes locally or is cloud-backed; an explicitly selected Full Access Mode has the same host capability ceiling in either case. Whether a Runtime asks before exercising that ceiling is a separate Permission Handling choice.
_Avoid_: Permission popup, full-auto flag

**Permission Handling**:
The user-visible choice of whether an Agent Runtime may exercise the selected Access Mode without asking or must pause for approval when the Runtime requires it. It does not expand the Access Mode capability ceiling, and changing its installation setting applies to new Agent Sessions rather than rewriting an existing Session Profile.
_Avoid_: Access Mode, sandbox mode, permission flag

**Automation Policy**:
The rules governing whether a Supervisor Session may create, inspect, steer, or stop Worker Sessions without user intervention.
_Avoid_: Autopilot

**Work Ledger**:
The durable local record of Work Orders, Worker Session state, Handoffs, and acceptance decisions for a Project.
_Avoid_: Task list, event log

**Supervisor Inbox**:
The durable queue of consolidated Worker notices waiting to be delivered to a Supervisor Session.
_Avoid_: Notification feed, polling result

**Supervisor Tenure**:
The bounded period during which one Supervisor Session owns coordination and acceptance for a Project.
_Avoid_: Main chat lifetime, permanent supervisor

**Delegation Cycle**:
One bounded Work Order dispatch followed by the Supervisor Session's recorded review disposition of the resulting Handoff. A revision that requires a new Handoff starts another Delegation Cycle.
_Avoid_: Raw prompt count, status check

**Supervisor Handover**:
A durable transfer package through which one Supervisor Session passes current decisions, evidence, active work, constraints, and the next recommended action to its successor.
_Avoid_: Chat summary, transcript dump

**Rotation Threshold**:
The maximum number of reviewed Delegation Cycles in one Supervisor Tenure before a successor Supervisor Session must take ownership. It is scoped to the Supervisor's Agent Runtime rather than shared, because the limit it encodes is that Runtime's context budget: currently six for a Codex Supervisor and ten for a Claude Code Supervisor. Reaching it is a ceiling, not the only trigger; the owner's observation of context pressure rotates earlier.
_Avoid_: Token limit, message count
