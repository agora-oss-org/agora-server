import { describe, expect, it } from "vitest";
import { matchesAny, parseMap } from "./map";

const GOOD = `
env-var:
  detect: [packages/core/src/lib/env.ts]
  mechanical: [.env.dev.example]
  prose: [docs/SELF-HOSTING.md]
endpoint:
  detect: ["apps/api/src/routes/**"]
  prose: [docs/MANIFEST.md]
exceptions:
  - subject: CRON_SECRET
    target: docker-compose.prod.yml
    reason: secret, never given a compose default
`;

describe("parseMap", () => {
  it("parses classes with detect/mechanical/prose and exceptions", () => {
    const map = parseMap(GOOD);
    expect(Object.keys(map.classes)).toEqual(["env-var", "endpoint"]);
    expect(map.classes["env-var"]!.mechanical).toEqual([".env.dev.example"]);
    expect(map.classes["endpoint"]!.mechanical).toEqual([]); // omitted → empty
    expect(map.exceptions).toEqual([
      { subject: "CRON_SECRET", target: "docker-compose.prod.yml", reason: "secret, never given a compose default" },
    ]);
  });

  it("rejects a class without detect patterns", () => {
    expect(() => parseMap("bad:\n  prose: [README.md]\n")).toThrow(/detect/);
  });

  it("rejects non-mapping top level and malformed exceptions", () => {
    expect(() => parseMap("- just\n- a list\n")).toThrow(/mapping/);
    expect(() => parseMap("c:\n  detect: [x]\nexceptions:\n  - subject: A\n")).toThrow(/exceptions\[0\]/);
  });
});

describe("matchesAny", () => {
  it("matches exact paths, * within a segment, and ** across segments", () => {
    expect(matchesAny("packages/core/src/lib/env.ts", ["packages/core/src/lib/env.ts"])).toBe(true);
    expect(matchesAny("apps/api/src/routes/deep/auth.ts", ["apps/api/src/routes/**"])).toBe(true);
    expect(matchesAny("apps/api/src/lib/env.ts", ["apps/*/src/lib/env*.ts"])).toBe(true);
    expect(matchesAny("docs/SELF-HOSTING.md", ["apps/**"])).toBe(false);
    expect(matchesAny("apps/api/src/lib/env.ts", ["apps/*/lib/env*.ts"])).toBe(false); // * must not cross /
  });
});
