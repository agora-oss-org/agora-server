import { describe, expect, it } from "vitest";
import type { PropagationClass } from "./map";
import { deriveEndpointObligations, deriveEnvObligations } from "./obligations";

const ENV_CLS: PropagationClass = {
  detect: ["packages/core/src/lib/env.ts"],
  mechanical: [".env.dev.example", "docker-compose.yml"],
  prose: ["docs/SELF-HOSTING.md"],
};

describe("deriveEnvObligations", () => {
  it("reports present/missing per target for an added key", () => {
    const obs = deriveEnvObligations({
      addedKeys: ["NEW_VAR"],
      removedKeys: [],
      targets: {
        ".env.dev.example": "NEW_VAR=1\n",
        "docker-compose.yml": "services:\n  agora:\n    environment:\n      OTHER: x\n",
        "docs/SELF-HOSTING.md": "no mention here\n",
      },
      cls: ENV_CLS,
      exceptions: [],
    });
    const by = Object.fromEntries(obs.map((o) => [o.target, o.status]));
    expect(by[".env.dev.example"]).toBe("present");
    expect(by["docker-compose.yml"]).toBe("missing");
    expect(by["docs/SELF-HOSTING.md"]).toBe("missing");
  });

  it("marks exceptions excepted and unreadable targets unparseable", () => {
    const obs = deriveEnvObligations({
      addedKeys: ["SECRET_VAR"],
      removedKeys: [],
      targets: { ".env.dev.example": null, "docker-compose.yml": "", "docs/SELF-HOSTING.md": "" },
      cls: ENV_CLS,
      exceptions: [{ subject: "SECRET_VAR", target: "docker-compose.yml", reason: "secret, no compose default" }],
    });
    expect(obs.find((o) => o.target === ".env.dev.example")?.status).toBe("unparseable");
    expect(obs.find((o) => o.target === "docker-compose.yml")?.status).toBe("excepted");
  });

  it("flags stale references to a removed key", () => {
    const obs = deriveEnvObligations({
      addedKeys: [],
      removedKeys: ["OLD_VAR"],
      targets: {
        ".env.dev.example": "OLD_VAR=1\n",
        "docker-compose.yml": "services: {}\n",
        "docs/SELF-HOSTING.md": "set OLD_VAR to tune\n",
      },
      cls: ENV_CLS,
      exceptions: [],
    });
    expect(obs).toHaveLength(2); // only the two targets still referencing it
    expect(obs.every((o) => o.status === "missing" && /stale/.test(o.note ?? ""))).toBe(true);
  });
});

describe("deriveEndpointObligations", () => {
  const CLS: PropagationClass = {
    detect: ["apps/api/src/routes/**"],
    mechanical: [],
    prose: ["docs/MANIFEST.md", "docs/MODELS.md"],
  };

  it("checks MANIFEST deterministically (param names normalized) and marks the rest advisory", () => {
    const obs = deriveEndpointObligations({
      addedRoutes: [
        { method: "GET", path: "/entities/:id" },
        { method: "POST", path: "/entities/brand-new" },
      ],
      cls: CLS,
      exceptions: [],
      manifestEntries: [{ method: "GET", path: "/entities/:entityId" }],
    });
    const get = obs.filter((o) => o.subject === "GET /entities/:id");
    expect(get.find((o) => o.target === "docs/MANIFEST.md")?.status).toBe("present");
    expect(get.find((o) => o.target === "docs/MODELS.md")?.status).toBe("advisory");
    const post = obs.filter((o) => o.subject === "POST /entities/brand-new");
    expect(post.find((o) => o.target === "docs/MANIFEST.md")?.status).toBe("missing");
  });
});
