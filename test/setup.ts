import { mock } from "bun:test";

// Conditional AWS SDK fallback, loaded via bunfig [test] preload.
//
// Some Windows setups (Bun 1.2.x + pnpm symlinked node_modules) fail to
// resolve "@aws-sdk/*" at import time with "Unexpected reading ...", which
// breaks every lambda test file at load. Every lambda test already stubs
// `.send` per test and never touches the network, so faithful fakes are
// sufficient — but ONLY as a fallback: this probe first tries the real
// modules, and healthy platforms (real SDK resolvable) see zero mocks.
let needMock = false;
try {
  await import("@aws-sdk/client-s3");
} catch {
  needMock = true;
}

if (needMock) {
  class FakeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  const named = (name: string) => ({ [name]: class extends FakeCommand {} })[name];

  class FakeClient {
    config: unknown;
    constructor(config?: unknown) {
      this.config = config;
    }
    send(): Promise<never> {
      throw new Error("FakeClient.send called without a per-test stub");
    }
  }

  mock.module("@aws-sdk/client-s3", () => ({
    S3Client: FakeClient,
    HeadObjectCommand: named("HeadObjectCommand"),
    GetObjectCommand: named("GetObjectCommand"),
    PutObjectCommand: named("PutObjectCommand"),
  }));
  mock.module("@aws-sdk/lib-dynamodb", () => ({
    DynamoDBDocumentClient: { from: (_client: unknown, _opts?: unknown) => new FakeClient({}) },
    UpdateCommand: named("UpdateCommand"),
    PutCommand: named("PutCommand"),
    GetCommand: named("GetCommand"),
    QueryCommand: named("QueryCommand"),
    BatchWriteCommand: named("BatchWriteCommand"),
  }));
  mock.module("@aws-sdk/client-sfn", () => ({
    SFNClient: FakeClient,
    StartExecutionCommand: named("StartExecutionCommand"),
  }));
  mock.module("@aws-sdk/client-dynamodb", () => ({
    DynamoDBClient: FakeClient,
  }));
  mock.module("@aws-sdk/s3-request-presigner", () => ({
    getSignedUrl: async (
      _client: unknown,
      command: { input: { Key: string } },
      opts: { expiresIn: number },
    ) => `https://mock-s3-upload.local/${command.input.Key}?expiresIn=${opts.expiresIn}`,
  }));
}
