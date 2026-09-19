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
  quiet: boolean;
  includeNoise: boolean;
  help: boolean;
  version: boolean;
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
    help: false,
    version: false,
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

    if (arg === "--stats") {
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

    if (arg.startsWith("--format=") || arg === "--format") {
      const val = arg.startsWith("--format=") ? arg.slice("--format=".length) : argv[++i];
      if (val !== "tree" && val !== "flat" && val !== "otel") {
        throw new Error(`Invalid format "${val}". Expected: tree | flat | otel`);
      }
      result.format = val;
      continue;
    }

    if (arg.startsWith("--output=") || arg === "--output") {
      const val = arg.startsWith("--output=") ? arg.slice("--output=".length) : argv[++i];
      if (val !== "terminal" && val !== "json" && val !== "html") {
        throw new Error(`Invalid output format "${val}". Expected: terminal | json | html`);
      }
      result.output = val;
      continue;
    }

    if (arg.startsWith("--rules=") || arg === "--rules") {
      const val = arg.startsWith("--rules=") ? arg.slice("--rules=".length) : argv[++i];
      if (!val) throw new Error("Missing value for --rules");
      result.rules = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    if (arg.startsWith("--ignore-fields=") || arg === "--ignore-fields") {
      const val = arg.startsWith("--ignore-fields=")
        ? arg.slice("--ignore-fields=".length)
        : argv[++i];
      if (!val) throw new Error("Missing value for --ignore-fields");
      result.ignoreFields = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    if (arg.startsWith("--tolerance=") || arg === "--tolerance") {
      const val = arg.startsWith("--tolerance=") ? arg.slice("--tolerance=".length) : argv[++i];
      if (!val) throw new Error("Missing value for --tolerance");
      let num = Number.parseFloat(val.replace("%", ""));
      if (Number.isNaN(num)) {
        throw new Error(`Invalid numeric tolerance: "${val}"`);
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
        throw new Error(`Invalid max-depth: "${val}"`);
      }
      result.maxDepth = depth;
      continue;
    }

    if (arg.startsWith("--html-out=") || arg === "--html-out") {
      const val = arg.startsWith("--html-out=") ? arg.slice("--html-out=".length) : argv[++i];
      if (!val) throw new Error("Missing file path for --html-out");
      result.htmlOut = val;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: "${arg}". Run with --help for usage.`);
    }

    positionals.push(arg);
  }

  if (positionals.length < 2) {
    throw new Error(
      `Expected 2 trace files, but received ${positionals.length}.\nUsage: tracediff <file_a> <file_b> [options]`,
    );
  }

  result.fileA = positionals[0];
  result.fileB = positionals[1];
  return result;
}

export function getHelpText(): string {
  return `tracediff v0.1.0 — Structural trace diffing with Merkle-indexed localization

Usage:
  tracediff <file_a> <file_b> [options]

Options:
  --format <format>         Input format: tree | flat | otel (default: auto)
  --output <format>         Output format: terminal | json | html (default: terminal)
  --rules <list>            Comma-separated rule names (e.g. ignore-timestamps,canonicalize-ids)
  --no-rules                Raw structural diff without equivalence normalization
  --ignore-fields <list>    Comma-separated attribute keys to ignore
  --tolerance <pct>         Relative tolerance for numeric attributes (e.g. 5% or 0.05)
  --max-depth <n>           Maximum traversal depth limit (default: 1000)
  --stats                   Display execution timing breakdown and Merkle skip statistics
  --html-out <path>         Write self-contained HTML visualization report to file
  --include-noise           Display noise-level variations in terminal output
  -q, --quiet               Suppress standard output (exit code only)
  -h, --help                Show this help message
  -v, --version             Show version number

Exit Codes:
  0                         No semantic differences found (traces are equivalent)
  1                         Semantic differences detected
  2                         Error (file not found, parse failure, invalid options)
`;
}
