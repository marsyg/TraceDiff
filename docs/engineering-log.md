---
layout: default
title: TraceDiff — Engineering Log
---

[← Open TraceDiff App](../) · [Home](index.html) · [Developers](developers.html) · [Hash experiment](hash-experiment.html) · **Engineering log**

# Engineering log: difficulties, tradeoffs, bugs

Blunt post-mortem style. Every entry: symptom → root cause → fix → lock-in.

## Difficulties

- **Bucket-boundary straddles vs recall.** ~2.3% of aligned nodes diverge post-normalization despite being within tolerance (log-bucket edges). Each poisons its ancestor chain, capping skip at ~91% instead of ~98%. Widening buckets would fix the symptom and silently merge real 5–10% regressions — so the guarantee stands and the cost is accepted.
- **Bun 1.2.4 + pnpm symlinks on Windows.** `bun test` could not resolve `@aws-sdk/*` (`Unexpected reading ...`) while `typescript` (same symlinks) loaded fine — scoped-path-specific resolver failure. Fixed with a conditional preload (`test/setup.ts`): probes the real SDK, registers faithful fakes only when resolution fails. Healthy platforms see zero mocks.
- **CRLF vs biome.** `core.autocrlf=true` with no `.gitattributes` rewrote working copies to CRLF (including via stash pop), failing `biome check` (LF) repo-wide. Fixed with `.gitattributes` (`* text=auto eol=lf`) + LF normalization. Lesson: line-ending policy belongs in the repo, not in machine config.
- **`.env` auto-load flipping tests.** Bun loads repo-root `.env`; a deployment `.env` containing `STATE_MACHINE_ARN` silently flipped `submit-job` tests into the live Step Functions branch (202 → 500). Fixed by stubbing `sfnClient.send` in the test. Lesson: ambient env is test input — hermetic tests must stub every client they can reach.
- **Toggle-vs-filter footgun.** Significance chips were multi-toggles; clicking "~ semantic" to *isolate* semantic hid it instead, rendering an empty tree with zero errors. (Follow-up direction: single-select All/Semantic/Uncertain/Noise.)

## Tradeoffs (accepted and rejected)

| Decision | Gain | Cost | Verdict |
|---|---|---|---|
| Fused normalizer + `RuleFuse` surface | ~5× on rule pass | New optional interface field; opaque-rule fallback | Accepted |
| Cached key-order serializer | ~40% of serialize stage | Cache + collision-safe path complexity | Accepted |
| Codepoint (not locale) child sort | Cheaper than ICU collation | Parallel-subtree hash values change | Accepted (versioned) |
| Vendored xxh64 as default | — | 6× slower than native (measured) | Reverted |
| `xxhash-wasm` dependency | ~20% total-bench est. | First runtime dep, digest migration, cache invalidation | Deferred |
| Widen numeric buckets | Fewer straddles, higher skip | Missed real regressions | Rejected |
| Collapse dual-hash to one | Half the hashing | Destroys identical-vs-noise distinction | Rejected |

## Bugs register

| Symptom | Root cause | Fix | Lock-in |
|---|---|---|---|
| `timestamp_raw` flagged semantic | `isTimestampKey` matched leaf segment only; string timestamps missed | Leaf set + unambiguous `timestamp`/`timestamps` any-segment markers (deliberately *not* blanket any-segment: `time_zone`, `date_of_birth` stay semantic) | 2 regression tests pulling opposite directions |
| REMOVED rows showed B-side parent path | Display preferred `pathB` for all types | Type-appropriate path (removed→A, added→B); contract untouched (`diff.test.ts:311` requires the anchors) | Existing anchor test + jotish re-run |
| Every tree row wore SEMANTIC pill | `rowState` read `.type` off a result *index* instead of the object → `undefined` → fallthrough | Resolve `state.results[idx]` first, with guard + comment | Headless page test asserting pill text per row |
| Duplicate labels shared collapse/selection state | Rows keyed by label path; 10 identical log lines one key | Unique instance keys + FIFO diff distribution mirroring backend matcher | Headless test: distinct `data-diff` in order |
| Semantic 5 invisible in tree | Key separator mismatch: literal U+0001 byte (index) vs `""` (lookup) — visually identical in every editor | Explicit `"\u0001"` escapes everywhere; orphan-anchor fallback to root | Key-agreement reasoning + render coverage |
| xxhash stripe wrongness (2 bugs) | Missing ×P1 in `round`; `(acc+input)×P2` operand order | Both fixed after WASM cross-check caught them | Canonical vectors + length sweep (kept with standalone save) |
| submit-job 202 → 500 with deployment `.env` | Bun auto-loads `.env`; truthy ARN entered live SFN branch with unstubbed client | Stub `sfnClient.send` in test | Full suite green with `.env` present |

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
