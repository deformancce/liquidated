# Liquidated

Liquidated is an audio-visual crypto flow instrument inspired by the density of trade aggregators, but tuned for a cleaner, more atmospheric interface.

The current prototype runs as a static web app:

- Binance USD-M futures aggregate trade stream
- Binance liquidation stream
- Canvas particle field for buy, sell, and liquidation pressure
- Web Audio pulses mapped to size, side, and liquidation events
- Demo mode for designing without a live socket

## Run

Open `index.html` directly in a browser, or serve the folder locally:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Direction

Next useful milestones:

- Add exchange adapters and a shared event schema
- Record and replay sessions
- Add market presets and multi-symbol views
- Build MIDI/OSC output for external audio tools
- Ship as a hosted GitHub Pages app
