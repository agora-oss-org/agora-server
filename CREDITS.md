# Open Source Acknowledgments

This project is built on the shoulders of giants — open-source software and tools that power Agora Server.

## Licensing Model

**Agora Server** uses a **dual license** model:
- **AGPL-3.0-only** for the main packages: `@agora/api`, `@agora/admin`, `@agora/secure-chat`, and `services/scorer`. You can use, modify, and distribute these under the terms of the AGPL-3.0 license.
- **Apache-2.0** for `@agora-server/contract` — the wire-contract layer. This permissive license makes it safe for third-party SDKs to depend on the contract types without copyleft obligations.

For the full license text, see the [LICENSE](LICENSE) file in this repository.

## Built with Claude Code

The development of Agora was accelerated and enriched by **[Claude Code](https://claude.com/code)**, Anthropic's AI-powered development assistant. Claude helped with:

- Architecture and design decisions across the monorepo
- Implementation of complex features (authentication, real-time chat, social graph)
- Type safety and test design (TypeScript, Vitest)
- Security reviews and hardening
- Documentation and compliance workflows

Claude Code is available as a CLI, desktop app (Mac/Windows), web app, and IDE extensions (VS Code, JetBrains). If you find this project useful, check it out — it's transforming how developers build.

---

## Direct Dependencies

This file lists all **direct dependencies** (packages explicitly listed in our `package.json` files). For a complete legal compliance audit, see [OSS-LICENSES.txt](OSS-LICENSES.txt).

### Runtime & Framework

**[Hono](https://hono.dev)** v4.12.23 — MIT  
Ultra-fast web framework for serverless/edge environments, Node.js, and browsers. Provides routing, middleware, context, and lightweight HTTP handling.

**[Node.js](https://nodejs.org)** ≥20 — MIT  
JavaScript runtime for server-side execution.

**[@hono/node-server](https://github.com/honojs/node-server)** v1.19.14 — MIT  
Adapter for running Hono applications on Node.js native HTTP server.

### Database & ORM

**[Drizzle ORM](https://orm.drizzle.team)** v0.45.2 — Apache-2.0  
Type-safe SQL query builder and lightweight ORM for PostgreSQL. Provides runtime zero-cost abstractions with full TypeScript support.

**[postgres.js](https://github.com/porsager/postgres)** v3.4.9 — MIT  
Fast, lightweight PostgreSQL client with transaction support, prepared statements, and Supabase transaction pooler compatibility.

**[drizzle-kit](https://orm.drizzle.team)** v0.31.10 — Apache-2.0  
CLI tool for generating SQL migrations from Drizzle schema definitions and managing schema versioning.

### Authentication, Cryptography & Identity

**[Supabase JS Client](https://supabase.com)** v2.107.0 — Apache-2.0  
Official JavaScript/TypeScript client for Supabase Auth (passwords, confirmation emails, OAuth) and Storage. Used for identity management and file uploads.

**[jose](https://github.com/panva/jose)** v5.10.0 — MIT  
Standards-compliant JWT creation, verification, and cryptographic operations (HS256, RS256, etc.). Used for Agora's token minting and validation.

**[@node-rs/argon2](https://github.com/napi-rs/node-rs)** v2.0.2 — MIT + Apache-2.0  
WASM-based Argon2id password hashing for secure password storage without Node.js native modules.

### Search & Embeddings

Voyage AI (external service, via API) — Proprietary  
Semantic search platform providing 1024-dimensional embeddings for content discovery.

### Real-Time Communication & Chat

**[Socket.io](https://socket.io)** v4.8.3 — MIT  
Real-time bidirectional communication library. Used for live chat delivery, presence indicators, notifications, and multi-user realtime events.

**[ioredis](https://github.com/luin/ioredis)** v5.11.1 — MIT  
High-performance Redis client for pub/sub, caching, and distributed rate-limiting across multiple server instances.

### End-to-End Encryption & Social Graph

**[neo4j-driver](https://neo4j.com)** v6.1.0 — Apache-2.0  
Official Node.js driver for Neo4j graph database. Used for modeling and querying social network features (optional, gated by `NEO4J_URI`).

### Validation & Serialization

**[Zod](https://zod.dev)** v3.25.76 — MIT  
TypeScript-first schema validation library. Used for parsing and validating request bodies, environment variables, and API contracts.

### File Storage & Image Processing

**[@aws-sdk/client-s3](https://aws.amazon.com/sdk-for-javascript/)** v3.901.0 — Apache-2.0  
AWS SDK for JavaScript S3 client. Used for uploading files to S3-compatible storage (MinIO for self-hosted, AWS S3 for managed).

**[sharp](https://sharp.pixelplumbing.com)** v0.34.5 — Apache-2.0  
High-performance image processing library. Used for converting uploads to WebP, generating thumbnails, and optimizing media files.

### Infrastructure & DevOps

**[Docker](https://www.docker.com)** — Apache-2.0  
Container runtime and orchestration platform. Agora is containerized for Supabase-hosted or self-hosted deployments.

**[Supabase](https://supabase.com)** — Apache-2.0 (open-source backend)  
PostgreSQL hosting platform with built-in Auth, Storage, and extensions (pgvector, PostGIS, pgmq). Used for managed deployments; self-hosted uses the same `supabase/postgres` image.

### Frontend UI & Styling

**[React](https://react.dev)** v18.3.1 — MIT  
JavaScript library for building user interfaces with component-based architecture.

**[React DOM](https://react.dev)** v18.3.1 — MIT  
React package for rendering components to the DOM.

**[React Router DOM](https://reactrouter.com)** v7.17.0 — MIT  
Declarative routing library for React single-page applications.

**[Radix UI](https://radix-ui.com)** (multiple packages, v1.x) — MIT  
Unstyled, accessible component primitives for building design systems. Used for dialogs, dropdowns, tabs, tooltips, avatars, and other UI components.

**[TailwindCSS](https://tailwindcss.com)** (via tailwind-merge) v3.6.0 — MIT  
Utility-first CSS framework merged with custom styles for consistent design.

**[Lucide React](https://lucide.dev)** v1.17.0 — ISC  
Beautiful, consistent SVG icon library for React.

**[TanStack React Query](https://tanstack.com/query/latest)** v5.101.0 — MIT  
Powerful data synchronization library for managing server state, caching, and background fetching.

**[clsx](https://github.com/lukeed/clsx)** v2.1.1 — MIT  
Utility for constructing className strings conditionally.

**[class-variance-authority](https://cva.style)** v0.7.1 — Apache-2.0  
Type-safe CSS class composition for component variants.

### Testing

**[Vitest](https://vitest.dev)** v4.1.8 — MIT  
Unit test runner built on Vite. Provides fast test execution, coverage reporting, and browser-like globals.

**[Socket.io Client](https://socket.io)** v4.8.3 — MIT  
Socket.io client library used in integration tests to verify real-time communication.

### Build, Development & Language

**[TypeScript](https://www.typescriptlang.org)** v5.9.3 — Apache-2.0  
Static type checker and language superset for JavaScript. Provides type safety across the entire monorepo.

**[tsx](https://github.com/esbuild-kit/tsx)** v4.22.4 — MIT  
TypeScript executor for Node.js. Enables `tsx watch` for live-reload development and `tsx` for running TS scripts.

**[dotenv](https://github.com/motdotla/dotenv)** v17.4.2 — BSD-2-Clause  
Environment variable loader. Parses `.env` files for local development and testing.

### Logging & Observability

**[@jenova-marie/wonder-logger](https://github.com/jenova-marie/wonder-logger)** v2.0.18 — MIT  
Structured logging library built on Pino. Provides debug, info, error levels with OpenTelemetry integration and color-aligned formatting.

### Package Management

**[pnpm](https://pnpm.io)** v10.14.0 — MIT  
Fast, disk-space-efficient package manager. Manages the monorepo workspaces and lock file.

---

## Contributing

Thank you for your interest! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## More Information

- **Full License:** [LICENSE](LICENSE)
- **Machine-Readable Compliance:** [OSS-LICENSES.txt](OSS-LICENSES.txt)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)
