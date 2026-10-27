# Twitch Chat TTS — Source

Primary: **desktop/** (Electron)
Secondary: **website/** (browser + python proxy)

## Desktop
```bash
cd desktop
npm install electron --save-dev
npx electron .
```

## Website
```bash
cd website
python3 proxy/tokenme_proxy.py
python3 -m http.server 8080
```

Glass Soft Style A layout (3-column desktop shell).
