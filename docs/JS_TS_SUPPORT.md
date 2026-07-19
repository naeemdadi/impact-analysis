# JavaScript and TypeScript Support

## Product contract

Impact Analysis builds a deterministic source graph for indexable JavaScript and TypeScript projects. A project receives user-facing verification recommendations only when a framework/protocol adapter proves its entrypoints and bindings.

```text
JS/TS modules and imports
→ project/workspace graph
→ framework entrypoints
→ optional protocol bindings
→ PR impact report
```

## Current profiles

| Profile | Deterministic facts | Verification targets |
|---|---|---|
| Next.js | App/Pages routes and route handlers | Pages and API handlers |
| React Router | Literal JSX and route-object registrations | Proven client routes |
| Remix | `app/routes` conventions | Route and resource handlers |
| Express | Literal HTTP registrations and mounted local routers | HTTP handlers |
| tRPC | Static router procedures and client hook calls | UI routes only when a binding is proven |
| Other JS/TS | Modules, symbols, imports, roles, styles | Graph-only evidence |

Fastify, Hono, Nest, TanStack Router, GraphQL, runtime route registries, and generated route/procedure code remain graph-only until dedicated adapters exist.

## Project discovery

The app detects standalone packages and npm, Yarn, and pnpm workspaces. Turborepo and Nx files are recognized as workspace signals. Each file belongs to its deepest package root; imports between local workspace packages become resolved graph edges.

Projects honor a root `tsconfig.json` or `jsconfig.json`. When neither exists, the graph uses conservative JavaScript defaults (`allowJs`, JSX parsing, and source-only resolution). External packages are recorded as external and are never fetched from `node_modules`.

When framework selection is ambiguous, commit an optional `impact-analysis.config.json`:

```json
{
  "projects": [
    { "root": "apps/web", "adapter": "react_router", "protocols": ["trpc"] },
    { "root": "apps/api", "adapter": "express", "protocols": ["trpc"] }
  ]
}
```

The configuration selects project roots and adapters only. It cannot declare routes, dependency edges, or impact claims manually.

## Evidence limits

Literal paths, components, handlers, and tRPC operation chains are required. Dynamic paths, remote route configuration, arbitrary route-array mapping, feature-flag route construction, and unbound tRPC procedures remain visible as graph evidence but never become user-flow recommendations.
