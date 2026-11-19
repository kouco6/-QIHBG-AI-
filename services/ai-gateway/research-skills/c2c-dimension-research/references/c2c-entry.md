## Workflow: dimension research（项目维度调研扩展）

When the user asks ChatGPT to conduct product dimension research through this
skill, check the current workspace for
`modules/ai-gateway/research-skills/c2c-dimension-research/SKILL.md`.
If present, read that entrypoint and follow its linked research contract and
the requested dimension rules. This is a project-scoped extension: do not apply
PAGA defaults to unrelated workspaces. If absent, locate the project's actual
research rules before proceeding; do not invent that the extension is installed.

Use this skill's normal connection, doctor gate, conversation, pairing and
recovery rules. ChatGPT pulls the domain skill files from the verified current
workspace; never paste their contents into chat. Codex sends small task/path
references, ChatGPT performs evidence-backed research using available retrieval,
and Codex collects complete results, validates and saves versioned artifacts.
The connector remains read-only. Do not claim platform integration, native
executor verification or successful research merely because files can be read.

This extension does not alter the ordinary coding PLAN/REVIEW workflow.
