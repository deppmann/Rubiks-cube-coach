# Rubik's Cube Coach

Static web app (plain ES modules, no build step). Read `docs/ARCHITECTURE.md` for module
contracts before changing any interface.

- Run tests: `npm test` (node --test, zero dependencies).
- Serve locally: `npm start`, then open http://localhost:8080.
- All cube logic goes through `src/cube.js`; never hand-write sticker permutations.
- The coach teaches the beginner layer-by-layer method with **white on the bottom**.
- Keep it phone-first: test layouts at 375px wide; tap targets ≥ 44px.
- No CDNs or network calls at runtime; third-party code is vendored in `vendor/`.
