# Sources, credits and thanks

Liquidated combines public market data, original product work, and open-source software. This page documents where the data and the two central algorithms come from.

{% hint style="info" %}
Publicly accessible data is not the same thing as open-source software. Hyperliquid exposes the market stream publicly; the software projects below each retain their own copyright and licence terms.
{% endhint %}

## Market data

The live instrument reads **trades** and **best bid/offer (BBO)** updates from the [Hyperliquid public WebSocket API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions). These public channels do not require a wallet connection or API key.

Thank you to the Hyperliquid team for making the live market-data interface available. Hyperliquid supplies the source events; Liquidated is an independent project and is not affiliated with or endorsed by Hyperliquid.

## Liquid algorithm

The liquid field is a customised GPU height-map wave simulation built with [three.js](https://threejs.org/) and its [`GPUComputationRenderer`](https://threejs.org/docs/#examples/en/misc/GPUComputationRenderer). Its technical lineage includes:

- the official three.js [`webgl_gpgpu_water` example](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_water.html), distributed with three.js under the MIT licence;
- Franky Hung's [`water-ripples`](https://github.com/franky-adl/water-ripples) demo, especially its bioluminescent `index3` variant, used as the starting point for the dedicated water study; and
- Pavel Dobryakov's [WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), an MIT-licensed source of visual and interaction inspiration.

Liquidated adds the market-specific behaviour: trade notional controls impact size, buy/sell side controls placement and colour, rolling pressure affects the surface, and the renderer adapts its direction to portrait and landscape layouts.

Thank you to the three.js contributors, Franky Hung, and Pavel Dobryakov for publishing the work that made this visual direction possible.

{% hint style="warning" %}
The `franky-adl/water-ripples` repository does not include an explicit licence file. Its underlying three.js example is MIT-licensed, but the absence of a separate licence for the port is recorded here rather than treating every part of it as open source.
{% endhint %}

## Sound algorithm

The sound engine uses the original [Mutable Instruments Rings DSP source](https://github.com/pichenettes/eurorack/tree/master/rings), created by **Émilie Gillet**, compiled to WebAssembly for the browser. The STM32F source in the Mutable Instruments Eurorack repository is published under the MIT licence.

Liquidated supplies the browser wrapper and musical mapping: trades excite resonator voices, size controls intensity, side shapes pitch and colour, and detected flow events create stronger strikes.

A sincere thank-you to Émilie Gillet for creating Rings and releasing its DSP source. That generosity makes this browser instrument possible.

“Mutable Instruments” and “Rings” identify the upstream work for attribution. Liquidated is an independent derivative and is not an official Mutable Instruments product or endorsement.

## Licence details

Liquidated is released under the [MIT licence](https://github.com/deformancce/liquidated/blob/main/LICENSE). Copyright and licence terms for third-party work remain with their respective authors. The repository's [`THIRD_PARTY_NOTICES.md`](https://github.com/deformancce/liquidated/blob/main/THIRD_PARTY_NOTICES.md) contains implementation-level notices.
