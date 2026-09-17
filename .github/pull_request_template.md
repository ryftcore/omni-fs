## What this changes

<!-- One or two sentences. -->

## Checklist

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint` passes
- [ ] Commit titles follow `:emoji: <type> <description>`, single line, no body
- [ ] Nothing in `packages/` imports `vscode` or `electron`; nothing in
      `packages/core` imports a protocol SDK
- [ ] No credentials, real endpoints or bucket names in code, tests or fixtures

## If this adds or changes a provider

- [ ] Native errors are translated to `OmniFsError` at the provider boundary
- [ ] `ProviderCapabilities` reflects what the protocol genuinely supports
- [ ] The shared conformance suite passes

## If this changes architecture

- [ ] An ADR is added under `docs/adr/`
