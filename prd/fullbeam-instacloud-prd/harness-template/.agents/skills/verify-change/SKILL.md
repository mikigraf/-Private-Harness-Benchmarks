---
name: verify-change
description: Reproduce a reported software defect, implement a focused fix, run available checks, and describe the evidence and remaining uncertainty.
---

Identify the reported behavior and reproduce it with the available public tests or a focused local check. Implement a coherent change that fits the repository's existing design.

Run the documented checks that are available in this snapshot. Summarize what changed, which commands actually ran, and their observed results. State verification gaps explicitly. A tool's successful exit or a plausible patch is not, by itself, proof that all required behavior is correct.
