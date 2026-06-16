# DozerDB + OpenGDS setup

Agora's social graph runs on **[DozerDB](https://dozerdb.org)** — a fully open-source Neo4j 5
distribution that ships **APOC** and **OpenGDS** without an Enterprise license. This is the setup
reference for the `neo4j` service in `docker-compose.yml`.

## Why DozerDB over stock Neo4j

| | Stock Neo4j Community | DozerDB 5.26.3.0 |
|---|---|---|
| APOC (full) | Enterprise only | ✅ included |
| GDS (graph algorithms) | Enterprise only | ✅ via OpenGDS |
| License | GPLv3 | GPLv3 (same core) |
| Cost | free (limited) | free (full) |

Louvain community detection, PageRank, betweenness centrality, and the other GDS algorithms the
social-graph read paths will use require GDS — which DozerDB makes available via the
**OpenGDS** plugin compiled for Neo4j Core 5.23+.

## Plugin loading — two mechanisms

| Plugin | How it loads | Source |
|---|---|---|
| APOC | Auto-download via `NEO4J_PLUGINS='["apoc"]'` | DozerDB image pull on first start |
| OpenGDS | Manual jar in `./neo4j/plugins/` mounted at `/plugins` | `neo4j/plugins/open-gds-2.12.0.jar` |

They load from **different directories**. APOC lands wherever the image's `NEO4J_PLUGINS` mechanism
puts it (`/var/lib/neo4j/plugins` in the base Neo4j image); OpenGDS lands in `/plugins` (the mount).
Both directories are on the plugin scan path for DozerDB.

If a plugin fails to load, exec in and check both dirs:

```bash
docker compose exec neo4j sh -c 'ls -la /plugins /var/lib/neo4j/plugins 2>/dev/null'
```

## Version compatibility

| Component | Version |
|---|---|
| DozerDB image | `graphstack/dozerdb:5.26.3.0` |
| Neo4j Core | 5.26.3 |
| OpenGDS | 2.12.0 (requires Neo4j Core ≥ 5.23) |
| APOC | latest compatible (auto-downloaded by image) |

To upgrade OpenGDS: download the new jar into `./neo4j/plugins/`, remove the old one, and restart
the service (`docker compose restart neo4j`).

## Initial jar download

The jar is **not** tracked in git (`neo4j/plugins/*.jar` is gitignored). Download it once after
cloning:

```bash
mkdir -p ./neo4j/plugins
curl -fsSL -o ./neo4j/plugins/open-gds-2.12.0.jar \
  https://dist.dozerdb.org/plugins/open-gds/open-gds-2.12.0.jar
```

## Environment variables

These are set in the `neo4j` service's `environment:` block in `docker-compose.yml`, pulling values
from `.env` via `${VAR:-default}` substitution. The neo4j service does **not** use `env_file: .env`
— Neo4j maps every `NEO4J_*` var to a config key, so passing `NEO4J_URI` (the connection URL used
by the API/scorer) would crash it with `Unrecognized setting: URI`.

`NEO4J_AUTH` is the one shared var: the same `user/password` string the API/scorer read from `.env`
is passed straight through to Neo4j as its auth setting.

| Variable | Value | Purpose |
|---|---|---|
| `NEO4J_PLUGINS` | `'["apoc"]'` | Auto-download APOC on first start |
| `NEO4J_dbms_security_procedures_unrestricted` | `gds.*,apoc.*` | Required for GDS + APOC to load |
| `NEO4J_dbms_security_procedures_allowlist` | `gds.*,apoc.*` | Same (belt + suspenders) |
| `NEO4J_apoc_export_file_enabled` | `true` | Enable APOC file export (used by graph utilities) |
| `NEO4J_apoc_import_file_enabled` | `true` | Enable APOC file import |
| `NEO4J_server_memory_heap_initial__size` | `512m` | JVM heap start — tune to host RAM |
| `NEO4J_server_memory_heap_max__size` | `1024m` | JVM heap max — tune to host RAM |
| `NEO4J_server_memory_pagecache_size` | `256m` | Page cache — tune to graph size |
| `NEO4J_ACCEPT_LICENSE_AGREEMENT` | `yes` | Required by the DozerDB image |

> ⚠️ `NEO4J_PLUGINS` includes only `"apoc"`, **not** `"apoc-extended"` or `"graph-data-science"`.
> OpenGDS is loaded via the manual jar mount, not the auto-download mechanism. Adding
> `"graph-data-science"` to `NEO4J_PLUGINS` would try to pull the Enterprise GDS from Neo4j's
> servers and fail — keep it out.

## Verify both plugins loaded

After `docker compose up`:

```bash
# Check GDS version (should return 2.12.0)
docker compose exec neo4j cypher-shell -u neo4j -p <password> "RETURN gds.version()"

# Check APOC version
docker compose exec neo4j cypher-shell -u neo4j -p <password> "RETURN apoc.version()"

# List all loaded procedures (optional)
docker compose exec neo4j cypher-shell -u neo4j -p <password> "SHOW PROCEDURES YIELD name WHERE name STARTS WITH 'gds' RETURN name LIMIT 10"
```

## TLS (production)

Bolt TLS is off by default (Neo4j 5.x dev-safe default). For production:

1. Set `NEO4J_dbms_ssl_policy_bolt_enabled=true` in `.env`
2. Configure the remaining `NEO4J_dbms_ssl_policy_bolt_*` vars
3. Uncomment the SSL volume mount in `docker-compose.yml`:
   ```yaml
   - ./deploy/neo4j/ssl:/ssl:ro
   ```
4. Place `private_key` and `public_crt` in `./deploy/neo4j/ssl/`
5. Update `NEO4J_URI` to `bolt+s://neo4j:7687` (TLS-required Bolt scheme)

## Memory tuning guide

Rough starting points from DozerDB docs:

| Host RAM | heap max | pagecache |
|---|---|---|
| 4 GB | 1g | 512m |
| 8 GB | 2g | 1g |
| 16 GB | 4g | 2g |
| 32 GB+ | 8g | 4g+ |

The social graph for a single-community deployment (tens of thousands of nodes, millions of edges)
fits comfortably in the 8 GB profile. Pagecache matters more than heap for read-heavy workloads.
