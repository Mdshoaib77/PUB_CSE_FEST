Fallback runner used when vitest/node_modules are unavailable (S17C). Bundle with esbuild, aliasing `vitest` to `vitest-shim.ts`,
`@festhub/shared` to a barrel that re-exports `packages/shared/src/{leaderboard,certificates}` and `dotenv/config` to an empty file, then `node out.cjs`.
Normal workflow: `npm test` (vitest).
