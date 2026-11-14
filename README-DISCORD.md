# HELLBALL ULTIMATE - Discord Activity

Static files only (no server code). Free to host.

## 1. Host it (pick one)
**Cloudflare Workers (same as HELLBALL 2):** in this folder run `npx wrangler deploy`.
You get `https://hellball-ultimate.<your-account>.workers.dev`.

**Or GitHub Pages:** push this folder to a repo (or a subfolder of one) and turn on Pages.

## 2. Make the Discord app
1. https://discord.com/developers/applications -> New Application ("HELLBALL ULTIMATE").
2. Activities -> URL Mappings:
   - Root mapping `/` -> `420dug420.github.io/hellballultimate`
   - Add a Proxy Path Mapping: prefix `/ws` -> `hellball-ultimate.420dirtydoug420.workers.dev` (the game's own server, deployed from `server/`)
3. Activities -> Settings: enable Activities. Supported platforms: Desktop (and Mobile if you want it).
4. Installation: add the app to your server. Start it from the voice channel rocket / Activities button.

## Notes
- Keep the file named `index.html` - Discord opens the root of the URL mapping.
- Saves (scores, achievements, cosmetics) live per Discord app, separate from the .exe and browser copies.
- The HellWORLD save from another activity can't be read here; import your hellbud by seed in CUSTOMIZE.

## HellWORLD
`hellworld/` is HellWORLD, launched from the HELLWORLD button on the main menu. Both games share one account and the hellbud save is kept on the server (`server/`).
