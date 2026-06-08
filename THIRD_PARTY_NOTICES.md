# Third-Party Notices

## WebGL Fluid Simulation

Liquidated's WebGL liquid renderer is adapted from the ideas and shader pipeline used in Pavel Dobryakov's WebGL Fluid Simulation.

- Project: https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
- License: MIT
- Copyright: Copyright (c) 2017 Pavel Dobryakov

The original project is licensed under the MIT License. Liquidated keeps its renderer modular and flow-driven for orderflow/audio-visual use.

## Water Ripples (GPGPU heightmap water)

Liquidated's top-down water ripple page (`water.html` / `src/water/`) is ported from Franky Hung's "Water Ripples" demo (the `index3` bioluminescent + UnrealBloom variant), which is itself adapted from the official three.js example `webgl_gpgpu_water`.

- Port source: https://github.com/franky-adl/water-ripples
- Upstream technique: https://github.com/mrdoob/three.js/blob/master/examples/webgl_gpgpu_water.html (three.js, MIT, Copyright (c) 2010-2024 three.js authors)

Note: the franky-adl/water-ripples repository does not publish an explicit license file; the underlying GPGPU water simulation derives from the MIT-licensed three.js example. The shaders, `core-utils.js` and `common-utils.js` under `src/water/` are kept verbatim from the upstream sources (only `global` → `globalThis` and module/asset import paths were adjusted for the Vite build).
