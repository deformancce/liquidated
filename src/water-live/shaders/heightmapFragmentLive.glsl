#define PI 3.1415926538
#define MAX_DROPS 32

// Feed-driven drops. Each drop is one order (or one aggregated tape line).
// dropPos is in centered world units (same space as the original mousePos).
uniform int dropCount;
uniform vec2 dropPos[ MAX_DROPS ];
uniform float dropSize[ MAX_DROPS ];   // footprint radius (was mouseSize)
uniform float dropAmp[ MAX_DROPS ];    // wave height contribution
uniform float dropCharge[ MAX_DROPS ]; // signed: + buy (green), - sell (red)

uniform float viscosityConstant;
uniform float chargeDecay;

void main()	{
    // 'heightmap' sampler and 'resolution' are injected by GPUComputationRenderer.
    vec2 cellSize = 1.0 / resolution.xy;
    vec2 uv = gl_FragCoord.xy * cellSize;

    // .x = height, .y = previous height, .z = trade-colour wave, .w = previous colour wave
    vec4 heightmapValue = texture2D( heightmap, uv );

    vec4 north = texture2D( heightmap, uv + vec2( 0.0, cellSize.y ) );
    vec4 south = texture2D( heightmap, uv + vec2( 0.0, - cellSize.y ) );
    vec4 east = texture2D( heightmap, uv + vec2( cellSize.x, 0.0 ) );
    vec4 west = texture2D( heightmap, uv + vec2( - cellSize.x, 0.0 ) );

    // Same wave integrator as the original demo
    float newHeight = ( ( north.x + south.x + east.x + west.x ) * 0.5 - heightmapValue.y ) * viscosityConstant;

    float charge = ( ( north.z + south.z + east.z + west.z ) * 0.5 - heightmapValue.w ) * chargeDecay;

    // World-space position of this texel (centered), matching the mouse mapping below
    vec2 worldPos = ( uv - vec2( 0.5 ) ) * vec2( GEOM_WIDTH, GEOM_HEIGHT );

    // Accumulate every active drop this frame
    for ( int i = 0; i < MAX_DROPS; i++ ) {
        if ( i >= dropCount ) break;
        float mousePhase = clamp( length( worldPos - vec2( dropPos[ i ].x, - dropPos[ i ].y ) ) * PI / dropSize[ i ], 0.0, PI );
        float influence = ( cos( mousePhase ) + 1.0 );
        newHeight += influence * dropAmp[ i ];
        float isNeutralDrop = 1.0 - step( 0.001, abs( dropCharge[ i ] ) );
        charge *= 1.0 - isNeutralDrop * clamp( influence * 0.5, 0.0, 1.0 );

        float incomingCharge = influence * dropCharge[ i ] * 0.45;
        charge += incomingCharge;
    }

    heightmapValue.y = heightmapValue.x;
    heightmapValue.x = newHeight;
    heightmapValue.w = heightmapValue.z;
    heightmapValue.z = clamp( charge, -1.5, 1.5 );

    gl_FragColor = heightmapValue;

}
