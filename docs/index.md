---
layout: default
title: TraceDiff — Structural Trace Diffing
---

[← Open TraceDiff App](../) · **Docs Home** · [Developers](developers.html) · [Hash experiment](hash-experiment.html) · [Engineering log](engineering-log.html)

# TraceDiff — find the 3 real diffs, skip the other 999,997 events

Two execution traces go in (function calls, spans, log lines — up to millions of events each). Out comes the answer to one question: **what actually changed?**

The trick: fingerprint every subtree with a hash. Identical fingerprints mean identical subtrees — skip them in O(1). Real traces are 95–99% identical between runs, so the walk visits only the ~1% that differs. Cost scales with **change size**, not trace size.

```mermaid
flowchart LR
  A["Trace A"] --> H1["hash every subtree"]
  B["Trace B"] --> H2["hash every subtree"]
  H1 --> C{"Same hash?"}
  H2 --> C
  C -->|"Yes, 99.9%"| Skip["Skip in O(1)"]
  C -->|"No, 0.1%"| Recurse["Recurse, find the diff"]
  Skip --> Win["100x faster than full compare"]
  Recurse --> Win
```

## The 30-second demo script

1. **Run the 1-click demo** in the frontend (or `bun run src/cli/main.ts fixtures/small-diff/a.json fixtures/small-diff/b.json -s`): 5 injected regressions surface as semantic diffs while timestamp jitter, rotated IDs, and reordered spans vanish as noise.
2. **Point at the skip line**: ~90%+ of nodes skipped via Merkle match — that percentage *is* the pitch.
3. **Open one diff**: the description names the exact field change and the rule that classified it (`via numeric-tolerance`, `via ignore-timestamps`) — judgment you can audit, not a black box.

## What it proves (measured, 100K nodes / 100 diffs)

| Metric | Before tuning | After tuning |
|---|---|---|
| Total diff time | 4149 ms | 2310 ms (~44% faster) |
| Merkle build | 4009 ms | 2169 ms |
| Skip rate | 91.3% | 91.3% (unchanged — correctness preserved) |
| Recall | exact | exact (bit-identical hashes) |

## Read deeper

- [Developers](developers.html) — cost model, hot-spot map, what changed and why
- [Hash experiment](hash-experiment.html) — the xxhash saga: validation, bugs caught, measured verdict
- [Engineering log](engineering-log.html) — difficulties, tradeoffs, full bugs register

<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  (function() {
    function renderMermaid() {
      if (typeof mermaid === "undefined") return;
      var blocks = document.querySelectorAll("pre code.language-mermaid, div.language-mermaid pre code, pre.language-mermaid, code.language-mermaid");
      blocks.forEach(function(code) {
        var container = code.closest(".language-mermaid") || code.closest("pre") || code;
        var div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = code.textContent.trim();
        container.parentNode.replaceChild(div, container);
      });
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
      mermaid.run();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderMermaid);
    } else {
      renderMermaid();
    }
  })();
</script>
