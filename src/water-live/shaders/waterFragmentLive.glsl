#define PHONG

uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;

#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying float heightValue;
varying float chargeValue;
varying float worldXValue;

void main() {

	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>

	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;

	#include <logdepthbuf_fragment>
	#include <map_fragment>

	float waveLight = smoothstep( 0.0, 1.0, heightValue );
	vec3 buyColor = vec3( 0.10, 1.00, 0.40 );
	vec3 sellColor = vec3( 1.00, 0.12, 0.18 );
	vec3 neutralColor = vec3( 1.0 );

	// Original-style bioluminescence: height draws the full wave, signed charge
	// softly tints it. Opposite sides meeting fade back toward bright neutral.
	float tradeMask = smoothstep( 0.015, 0.34, abs( chargeValue ) );
	float sideMix = smoothstep( -0.45, 0.45, chargeValue );
	float rightGate = smoothstep( -0.16, 0.16, worldXValue / GEOM_WIDTH );
	float sellAmount = ( 1.0 - sideMix ) * ( 1.0 - rightGate ) * tradeMask;
	float buyAmount = sideMix * rightGate * tradeMask;
	float filteredMask = clamp( sellAmount + buyAmount, 0.0, 1.0 );
	vec3 sideColor = ( sellColor * sellAmount + buyColor * buyAmount ) / max( filteredMask, 0.001 );
	vec3 glowColor = mix( neutralColor, sideColor, filteredMask * 0.92 );
	vec3 chargedGlow = glowColor * waveLight;

	diffuseColor.rgb *= chargedGlow;
	totalEmissiveRadiance += chargedGlow * 0.24;

	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>

	// accumulation
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>

	// modulation
	#include <aomap_fragment>

	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;

	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>

}
