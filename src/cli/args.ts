export const VERSION = "tracediff v0.1.0";

export const AVAILABLE_FORMATS = ["tree", "flat", "otel"] as const;
export const AVAILABLE_OUTPUTS = ["terminal", "json", "html"] as const;
export const AVAILABLE_RULES = [
  "ignore-timestamps",
  "canonicalize-ids",
  "numeric-tolerance",
  "sort-concurrent",
  "ignore-fields",
] as const;

const KNOWN_FLAGS = [
  "--format",
  "--output",
  "--rules",
  "--no-rules",
  "--ignore-fields",
  "--tolerance",
  "--max-depth",
  "--stats",
  "--html-out",
  "--include-noise",
  "--export-repro",
  "--list-rules",
  "--no-color",
  "--quiet",
  "--help",
  "--version",
  "--finops",
  "--requests-per-month",
];

export interface CliArgs {
  fileA: string;
  fileB: string;
  format?: "tree" | "flat" | "otel";
  output: "terminal" | "json" | "html";
  rules?: string[];
  noRules: boolean;
  ignoreFields?: string[];
  tolerance?: number;
  maxDepth: number;
  stats: boolean;
  htmlOut?: string;
  /** Output directory for --export-repro. When set, write repro-diff-N.sh and repro-diff-N.test.ts files. */
  exportReproDir?: string;
  quiet: boolean;
  includeNoise: boolean;
  listRules: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
  finops: boolean;
  requestsPerMonth: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    fileA: "",
    fileB: "",
    output: "terminal",
    noRules: false,
    maxDepth: 1000,
    stats: false,
    quiet: false,
    includeNoise: false,
    listRules: false,
    noColor: false,
    help: false,
    version: false,
    finops: false,
    requestsPerMonth: 10_000_000,
  };

  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      result.help = true;
      return result;
    }

    if (arg === "-v" || arg === "--version") {
      result.version = true;
      return result;
    }

    if (arg === "-q" || arg === "--quiet") {
      result.quiet = true;
      continue;
    }

    if (arg === "-s" || arg === "--stats") {
      result.stats = true;
      continue;
    }

    if (arg === "--no-rules") {
      result.noRules = true;
      continue;
    }

    if (arg === "--include-noise") {
      result.includeNoise = true;
      continue;
    }

    if (arg === "--list-rules") {
      result.listRules = true;
      return result;
    }

    if (arg === "--no-color") {
      result.noColor = true;
      continue;
    }

    if (arg === "-f" || arg.startsWith("--format=") || arg === "--format") {
      const val =
        arg === "-f"
          ? argv[++i]
          : arg.startsWith("--format=")
            ? arg.slice("--format=".length)
            : argv[++i];
      if (val !== "tree" && val !== "flat" && val !== "otel") {
        throw new Error(
          `Invalid format "${val ?? ""}". Expected one of: ${AVAILABLE_FORMATS.join(" | ")}\nTip: omit --format to auto-detect.`,
        );
      }
      result.format = val;
      continue;
    }

    if (arg === "-o" || arg.startsWith("--output=") || arg === "--output") {
      const val =
        arg === "-o"
          ? argv[++i]
          : arg.startsWith("--output=")
            ? arg.slice("--output=".length)
            : argv[++i];
      if (val !== "terminal" && val !== "json" && val !== "html") {
        throw new Error(
          `Invalid output format "${val ?? ""}". Expected one of: ${AVAILABLE_OUTPUTS.join(" | ")}`,
        );
      }
      result.output = val;
      continue;
    }

    if (arg === "-r" || arg.startsWith("--rules=") || arg === "--rules") {
      const val =
        arg === "-r"
          ? argv[++i]
          : arg.startsWith("--rules=")
            ? arg.slice("--rules=".length)
            : argv[++i];
      if (!val)
        throw new Error(
          "Missing value for --rules. Example: --rules ignore-timestamps,canonicalize-ids",
        );
      const names = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const unknown = names.filter((n) => !(AVAILABLE_RULES as readonly string[]).includes(n));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown equivalence rule "${unknown[0]}". Available: ${AVAILABLE_RULES.join(", ")}\nTip: run 'tracediff --list-rules' to see what each rule does.`,
        );
      }
      result.rules = names;
      continue;
    }

    if (arg.startsWith("--ignore-fields=") || arg === "--ignore-fields") {
      const val = arg.startsWith("--ignore-fields=")
        ? arg.slice("--ignore-fields=".length)
        : argv[++i];
      if (!val)
        throw new Error(
          "Missing value for --ignore-fields. Example: --ignore-fields request_id,trace_id",
        );
      result.ignoreFields = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    if (arg.startsWith("--tolerance=") || arg === "--tolerance") {
      const val = arg.startsWith("--tolerance=") ? arg.slice("--tolerance=".length) : argv[++i];
      if (!val) throw new Error("Missing value for --tolerance. Example: --tolerance 5%");
      let num = Number.parseFloat(val.replace("%", ""));
      if (Number.isNaN(num) || num < 0) {
        throw new Error(`Invalid numeric tolerance: "${val}". Example: --tolerance 5%`);
      }
      if (val.includes("%") || num > 1) {
        num = num / 100;
      }
      result.tolerance = num;
      continue;
    }

    if (arg.startsWith("--max-depth=") || arg === "--max-depth") {
      const val = arg.startsWith("--max-depth=") ? arg.slice("--max-depth=".length) : argv[++i];
      const depth = Number.parseInt(val ?? "", 10);
      if (Number.isNaN(depth) || depth < 1) {
        throw new Error(
          `Invalid max-depth: "${val}". Expected a positive integer (default: 1000).`,
        );
      }
      result.maxDepth = depth;
      continue;
    }

    if (arg.startsWith("--html-out=") || arg === "--html-out") {
      const val = arg.startsWith("--html-out=") ? arg.slice("--html-out=".length) : argv[++i];
      if (!val)
        throw new Error("Missing file path for --html-out. Example: --html-out report.html");
      result.htmlOut = val;
      continue;
    }

    if (arg === "--finops") {
      result.finops = true;
      continue;
    }

    if (arg.startsWith("--requests-per-month=") || arg === "--requests-per-month") {
      const val = arg.startsWith("--requests-per-month=")
        ? arg.slice("--requests-per-month=".length)
        : argv[++i];
      const num = Number.parseInt(val ?? "", 10);
      if (Number.isNaN(num) || num < 1) {
        throw new Error(
          `Invalid requests-per-month: "${val}". Expected a positive integer (default: 10000000).`,
        );
      }
      result.requestsPerMonth = num;
      continue;
    }

    if (arg.startsWith("--export-repro=") || arg === "--export-repro") {
      const val = arg.startsWith("--export-repro=")
        ? arg.slice("--export-repro=".length)
        : argv[++i];
      if (!val) {
        throw new Error(
          "Missing directory for --export-repro. Example: --export-repro ./repro-out",
        );
      }
      result.exportReproDir = val;
      continue;
    }

    if (arg.startsWith("-")) {
      const hint = suggestFlag(arg);
      throw new Error(
        `Unknown option: "${arg}".${hint}\nRun 'tracediff --help' to see all options.`,
      );
    }

    positionals.push(arg);
  }

  if (positionals.length < 2) {
    const got = positionals.length === 0 ? "no files" : `only 1 file ("${positionals[0]}")`;
    throw new Error(
      `Expected 2 trace files, but received ${positionals.length} (${got}).\nUsage: tracediff <file_a> <file_b> [options]\nExample: tracediff trace_a.json trace_b.json --stats`,
    );
  }

  if (positionals.length > 2) {
    throw new Error(
      `Too many files: expected 2 but received ${positionals.length} (${positionals.join(", ")}).\nUsage: tracediff <file_a> <file_b> [options]`,
    );
  }

  result.fileA = positionals[0];
  result.fileB = positionals[1];
  return result;
}

function suggestFlag(arg: string): string {
  const name = arg.split("=")[0];
  // Suggest by shared prefix/substring, e.g. --ouput -> --output.
  const candidate = KNOWN_FLAGS.find(
    (f) => f.includes(name.replace(/-/g, "")) || name.includes(f.replace(/-/g, "")),
  );
  if (candidate) return ` Did you mean "${candidate}"?`;
  // Fall back to closest edit distance for short typos.
  let best: string | undefined;
  let bestDist = 3;
  for (const flag of KNOWN_FLAGS) {
    const dist = editDistance(name, flag);
    if (dist < bestDist) {
      bestDist = dist;
      best = flag;
    }
  }
  return best ? ` Did you mean "${best}"?` : "";
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export function getRulesText(): string {
  return `${VERSION} — available equivalence rules

  ignore-timestamps     Strip timestamp / start_time / end_time fields
  canonicalize-ids      Replace UUID / hex IDs with stable placeholders
  numeric-tolerance     Bucket numbers within tolerance (see --tolerance)
  sort-concurrent       Sort children of parallel spans before hashing
  ignore-fields         Ignore custom attribute keys (see --ignore-fields)

Use: tracediff <file_a> <file_b> --rules ignore-timestamps,canonicalize-ids
`;
}

export function getHelpText(): string {
  return `${VERSION} — Structural trace diffing with Merkle-indexed localization

Usage:
  tracediff <file_a> <file_b> [options]
  tracediff --list-rules

Compare:
  -f, --format <fmt>      Input format: tree | flat | otel (default: auto-detect)
  -r, --rules <list>      Only run these rules (default: all). See --list-rules
      --no-rules          Raw structural diff, skip all normalization
      --ignore-fields <list>  Extra attribute keys to ignore
      --tolerance <pct>   Numeric tolerance, e.g. 5% or 0.05 (default: 5%)
      --max-depth <n>     Max traversal depth (default: 1000)

Output:
  -o, --output <fmt>      terminal | json | html (default: terminal)
  -s, --stats             Show timing + Merkle skip statistics
      --finops            Compute FinOps cloud cost regression impact
      --requests-per-month <n> Monthly request volume for FinOps (default: 10M)
      --include-noise     Also show noise-level diffs (hidden by default)
      --html-out <path>   Also write a shareable HTML report to file
      --export-repro <dir> Write repro-diff-N.sh (cURL) and repro-diff-N.test.ts (Vitest) for each semantic diff
  -q, --quiet             Print nothing, exit code only
      --no-color          Disable ANSI colors (also respects NO_COLOR=1)

Other:
      --list-rules        List equivalence rules and exit
  -h, --help              Show this help message
  -v, --version           Show version number

Examples:
  tracediff trace_a.json trace_b.json
  tracediff trace_a.json trace_b.json -s
  tracediff trace_a.json trace_b.json -r ignore-timestamps,canonicalize-ids -s
  tracediff trace_a.json trace_b.json --include-noise --html-out report.html
  tracediff trace_a.json trace_b.json -o json > diff.json

Exit codes:
  0  No semantic differences (traces are equivalent)
  1  Semantic differences detected
  2  Error (file not found, parse failure, invalid option)
`;
}
